/**
 * The empty-completion guard.
 *
 * What was measured against wokey's Responses route
 * (`gpt-6-luna`, 2026-10-13, `sk-b2992a…`):
 *
 *   A request whose `input` replays a `function_call` item with **no matching
 *   `function_call_output`** comes back `200` with `status: "completed"`,
 *   `output: []` and `usage.total_tokens: 0` — reproducible 3/3, identical with
 *   and without the item's `id`. Add the matching `function_call_output` and the
 *   same request completes normally. So the relay honours OpenAI's rule and
 *   resolves a dangling call by voiding the turn, without saying so.
 *
 *   pi-ai maps `completed` to stopReason `"stop"`
 *   (`openai-responses-shared.js`, `mapStopReason`), so this lands in the
 *   transcript as an assistant message with no content and the session looks
 *   like it stalled: no text, no tool call, no error.
 *
 *   pi always pairs a tool call with its result, so it does not produce the
 *   dangling form itself. The guard exists because the failure mode is silent
 *   rather than loud: anything upstream that voids a turn the same way would
 *   read as a hung session, and the cheapest defence is to notice the shape.
 *
 * How a retry stays compatible with streaming: nothing is forwarded to the
 * client until the first output-bearing event (`response.output_item.added`, or
 * any content/reasoning delta). A turn that turns out to be empty never
 * produces one, so at that point the client has been sent nothing it could use
 * and the attempt can be discarded and re-issued inside the same response body.
 * A turn that produces anything is released on its first item and streams on
 * untouched from there. Hold-back is capped, so a pathological pre-content
 * prefix degrades to "no retry" rather than to unbounded buffering.
 *
 * When the retries are exhausted the guard emits an SSE `error` event — the
 * shape pi's Responses adapter already turns into a thrown provider error
 * (`openai-responses-shared.js`) — rather than a silent stall.
 *
 * Scope: the Responses route only. Nothing comparable has been observed on the
 * Anthropic route (`claude-opus-5-5` and `claude-haiku-5-5` returned content on
 * every request), and guessing at an Anthropic empty signature would risk
 * retrying healthy requests.
 */

type FetchArg = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

/** Hold-back ceiling. Past this the guard gives up on retrying and streams on. */
const MAX_HELD_BYTES = 256 * 1024;

export interface EmptyCompletionGuardOptions {
	/**
	 * Decides whether a request is one whose empty signature we know how to read.
	 * Default: `POST` to a path ending in `/responses`.
	 */
	appliesTo?(url: string, init: FetchInit | undefined): boolean;
	/** Re-issues allowed after the first empty completion. Default 1. */
	maxRetries?: number;
	/** Called before each retry, for logging or a status line. */
	onRetry?(info: { attempt: number; url: string; reason: string }): void;
}

/** The Responses-route default: a POST whose path ends at `/responses`. */
function isResponsesRequest(url: string, init: FetchInit | undefined): boolean {
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "POST") return false;
	try {
		const path = new URL(url).pathname.replace(/\/+$/, "");
		return path.endsWith("/responses");
	} catch {
		return false;
	}
}

interface ScanState {
	/** Any event that means the model produced something. */
	contentSeen: boolean;
	/** A terminal `response.completed` carrying a token count. */
	totalTokens: number | null;
	completed: boolean;
}

const freshScan = (): ScanState => ({ contentSeen: false, totalTokens: null, completed: false });

/**
 * Read one SSE line. Deliberately substring-based: the payloads are large (the
 * completed event embeds the whole response), so this never parses JSON — it
 * tests for the few markers that matter and pulls `total_tokens` out of the
 * terminal event.
 */
function scanSseLine(line: string, state: ScanState): void {
	const trimmed = line.trim();
	if (trimmed.startsWith("event:")) {
		const name = trimmed.slice(6).trim();
		if (name.startsWith("response.output_item.")) state.contentSeen = true;
		else if (name === "response.output_text.delta" || name === "response.function_call_arguments.delta") {
			state.contentSeen = true;
		}
		return;
	}
	if (!trimmed.startsWith("data:")) return;
	const payload = trimmed.slice(5);
	if (payload === "[DONE]") return;
	if (payload.includes('"type":"response.output_item.added"')) state.contentSeen = true;
	else if (
		payload.includes('"type":"response.output_text.delta"') ||
		payload.includes('"type":"response.function_call_arguments.delta"') ||
		payload.includes('"type":"response.reasoning_summary_text.delta"')
	) {
		state.contentSeen = true;
	}
	if (payload.includes('"type":"response.completed"')) {
		state.completed = true;
		const match = /"total_tokens":(\d+)/.exec(payload);
		if (match) state.totalTokens = Number(match[1]);
	}
}

/** Empty means: terminal, nothing produced, and nothing billed. */
function isEmptyCompletion(state: ScanState): boolean {
	return state.completed && !state.contentSeen && state.totalTokens === 0;
}

/** The same signature read off a non-streaming JSON body. */
function isEmptyJsonBody(text: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object") return false;
	const body = parsed as { output?: unknown; usage?: { total_tokens?: unknown } };
	if (body.usage?.total_tokens !== 0) return false;
	return Array.isArray(body.output) && body.output.length === 0;
}

const emptyCompletionError = (attempts: number): string =>
	JSON.stringify({
		error: {
			message:
				`wokey returned an empty completion ${attempts} time${attempts === 1 ? "" : "s"} in a row: ` +
				"the turn closed with no output items and zero billed tokens, which an OpenAI Responses " +
				"client reads as a finished but empty turn. Nothing was generated.",
			type: "wokey_empty_completion",
			code: "empty_completion",
		},
	});

/** The SSE form of the same error, for a stream that already started. */
const emptyCompletionSseError = (attempts: number): Uint8Array =>
	new TextEncoder().encode(
		`event: error\ndata: ${JSON.stringify({
			type: "error",
			code: "empty_completion",
			message:
				`wokey returned an empty completion ${attempts} time${attempts === 1 ? "" : "s"} in a row: ` +
				"the turn closed with no output items and zero billed tokens. Nothing was generated.",
		})}\n\n`,
	);

interface GuardContext {
	/** Issues the next attempt; `undefined` when the attempts are spent. */
	next(): Promise<Response | undefined>;
	url: string;
}

/**
 * One attempt's body, held back until the turn proves it has content.
 *
 * Resolves to "keep" or "retry": `retry` means this attempt produced nothing
 * and nothing was forwarded, so the caller may swap in another response.
 */
function guardedBody(body: ReadableStream<Uint8Array>, onVerdict: (empty: boolean) => void): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = freshScan();
	const held: Uint8Array[] = [];
	let heldBytes = 0;
	let released = false;
	let tail = "";

	const settle = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void => {
		if (released) {
			controller.enqueue(chunk);
			return;
		}
		released = true;
		for (const pending of held) controller.enqueue(pending);
		held.length = 0;
		heldBytes = 0;
		controller.enqueue(chunk);
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			// One pull drains until there is something to hand over. Returning early
			// with the chunk still held would stall: the inner stream is then idle
			// while the outer pull is still awaiting it, and nothing re-pulls it.
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					if (tail.length > 0) scanSseLine(tail, state);
					const empty = isEmptyCompletion(state);
					onVerdict(empty);
					if (empty) {
						// Nothing was forwarded, so the attempt can be dropped whole.
						await reader.cancel().catch(() => {});
						controller.close();
						return;
					}
					if (!released) for (const pending of held) controller.enqueue(pending);
					held.length = 0;
					controller.close();
					return;
				}
				if (released) {
					controller.enqueue(value);
					return;
				}
				tail += decoder.decode(value, { stream: true });
				const lines = tail.split("\n");
				tail = lines.pop() ?? "";
				for (const line of lines) scanSseLine(line, state);

				held.push(value);
				heldBytes += value.byteLength;
				if (state.contentSeen || heldBytes > MAX_HELD_BYTES) {
					settle(controller, value);
					return;
				}
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * One response body that may span several attempts.
 *
 * A retry is spliced in here rather than answered as a second Response: the
 * client already holds this Response, and the only attempt it can discard is
 * one whose body never reached it. The guard holds each attempt back until its
 * first output-bearing event, so "empty" is decided before anything is
 * forwarded and the swap costs the client nothing.
 */
function streamingGuard(
	first: Response,
	next: (attemptsMade: number) => Promise<Response | undefined>,
	exhaustedMessage: (attempts: number) => Uint8Array,
): ReadableStream<Uint8Array> {
	let attempts = 1;
	let verdict: boolean | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	const start = (response: Response): void => {
		verdict = undefined;
		reader = guardedBody(response.body!, (empty) => {
			verdict = empty;
		}).getReader();
	};
	start(first);

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (reader) {
				const { done, value } = await reader.read();
				if (!done) {
					controller.enqueue(value);
					return;
				}
				if (verdict !== true) {
					controller.close();
					return;
				}
				// This attempt produced nothing and nothing was forwarded, so it is
				// dropped whole and the next one takes over the same body.
				const retry = await next(attempts);
				if (!retry?.ok || !retry.body) {
					// `attempts` is what was really spent; a refused retry spends none.
					controller.enqueue(exhaustedMessage(attempts));
					controller.close();
					return;
				}
				attempts += 1;
				start(retry);
			}
		},
		cancel(reason) {
			return reader?.cancel(reason);
		},
	});
}

export function createEmptyCompletionGuardFetch(
	inner: typeof globalThis.fetch,
	options: EmptyCompletionGuardOptions = {},
): typeof globalThis.fetch {
	const appliesTo = options.appliesTo ?? isResponsesRequest;
	const maxRetries = options.maxRetries ?? 1;

	return async function guardedFetch(input: FetchArg, init?: FetchInit): Promise<Response> {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!appliesTo(url, init)) return inner(input, init);
		// An aborted request is the caller's decision, not an empty completion.
		if (init?.signal?.aborted) return inner(input, init);

		// Clone a Request up front: its body is single-use, so a retry needs its
		// own copy before the first attempt consumes the original.
		const spare: FetchArg = input instanceof Request ? input.clone() : input;
		const requestFor = (attempt: number): FetchArg => (attempt === 0 ? input : spare);

		// `attemptsMade` counts every attempt already spent on this request, so the
		// retry budget is spent once across the whole exchange instead of being
		// re-armed for each retry — which would re-issue forever, one body at a time.
		const nextAttempt = async (attemptsMade: number): Promise<Response | undefined> => {
			if (attemptsMade > maxRetries) return undefined;
			options.onRetry?.({ attempt: attemptsMade + 1, url, reason: "empty completion" });
			const response = await inner(requestFor(attemptsMade), init);
			const contentType = response.headers.get("content-type") ?? "";
			if (response.ok && response.body && /text\/event-stream/i.test(contentType)) return response;
			// A retry that is not a usable stream cannot be spliced in behind a
			// client that already holds this body; report the original fault.
			return undefined;
		};

		for (let attempt = 0; ; attempt++) {
			const response = await inner(requestFor(attempt), init);
			if (!response.ok) return response;

			const contentType = response.headers.get("content-type") ?? "";

			if (!response.body || !/text\/event-stream/i.test(contentType)) {
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (!isEmptyJsonBody(new TextDecoder().decode(bytes))) {
					return new Response(bytes, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				}
				if (attempt >= maxRetries) {
					return new Response(emptyCompletionError(attempt + 1), {
						status: 502,
						statusText: "Bad Gateway",
						headers: {
							"content-type": "application/json",
							"x-wokey-empty-completion": String(attempt + 1),
						},
					});
				}
				options.onRetry?.({ attempt: attempt + 1, url, reason: "empty completion (non-streaming)" });
				continue;
			}

			const body = streamingGuard(response, nextAttempt, emptyCompletionSseError);
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}
	};
}
