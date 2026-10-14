import { describe, expect, it, vi } from "vitest";
import { createEmptyCompletionGuardFetch } from "./resilience.ts";

/**
 * The signature measured on wokey's Responses route: `status:"completed"`,
 * `output: []`, `usage.total_tokens: 0` — a finished turn with nothing in it.
 * Both stream and non-stream bodies carry it; the guard reads each its own way.
 */
const sse = (events: string[]): string => events.map((e) => `${e}\n\n`).join("");

const PREFIX = [sse(["event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}"])];
const CONTENT = sse([
	'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}',
	'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}',
]);
const COMPLETED = (total: number) =>
	sse([`event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"total_tokens":${total}}}}`]);

const EMPTY_TURN = [...PREFIX, COMPLETED(0)];
const HEALTHY_TURN = [...PREFIX, ...CONTENT.split("\n\n").slice(0, -1).map((e) => `${e}\n\n`), COMPLETED(42)];

/** A fetch that replays canned SSE bodies, one per call. */
function fakeStreamFetch(bodies: string[], log?: string[]) {
	return vi.fn(async (input: unknown) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		log?.push(url);
		const body = bodies.shift();
		if (body === undefined) throw new Error("fake fetch ran out of bodies");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of body.split(/(?<=\n\n)/)) {
					if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
				}
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof globalThis.fetch;
}

const readAll = async (response: Response): Promise<string> => {
	const text = await response.text();
	return text;
};

const URL_RESPONSES = "https://api.wokey.ai/v1/responses";

describe("empty-completion guard", () => {
	it("passes a turn with content through untouched, with no extra request", async () => {
		const inner = fakeStreamFetch([HEALTHY_TURN.join("")]);
		const guarded = createEmptyCompletionGuardFetch(inner);

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const text = await readAll(response);

		expect(inner).toHaveBeenCalledOnce();
		expect(text).toContain("response.output_text.delta");
		expect(text).toContain('"total_tokens":42');
	});

	it("holds the pre-content prefix back until the turn proves it has output", async () => {
		const pulled: string[] = [];
		const inner = vi.fn(async () => {
			const chunks = HEALTHY_TURN.join("").split(/(?<=\n\n)/).filter(Boolean);
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks.shift();
					pulled.push(chunk!);
					if (chunk === undefined) controller.close();
					else controller.enqueue(new TextEncoder().encode(chunk));
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof globalThis.fetch;
		const guarded = createEmptyCompletionGuardFetch(inner);

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const reader = response.body!.getReader();
		// Read the first byte the client can see; by then the upstream must already
		// have produced an output item, because the prefix is still held.
		await reader.read();
		expect(pulled.some((chunk) => chunk.includes("response.output_item.added"))).toBe(true);
		await reader.cancel();
	});

	it("retries an empty stream once and hands the client only the good turn", async () => {
		const inner = fakeStreamFetch([EMPTY_TURN.join(""), HEALTHY_TURN.join("")]);
		const retries: string[] = [];
		const guarded = createEmptyCompletionGuardFetch(inner, { onRetry: (i) => retries.push(i.reason) });

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const text = await readAll(response);

		expect(inner).toHaveBeenCalledTimes(2);
		expect(retries).toEqual(["empty completion"]);
		expect(text).toContain("response.output_text.delta");
		// The voided attempt left no trace: no `total_tokens: 0`, no doubled prefix.
		expect(text).not.toContain('"total_tokens":0');
		expect(text.match(/"type":"response\.created"/g)).toHaveLength(1);
	});

	it("reports an SSE error when every attempt comes back empty", async () => {
		// Three bodies on offer: the guard must stop at two, proving the retry
		// budget is spent once rather than re-armed per attempt.
		const inner = fakeStreamFetch([EMPTY_TURN.join(""), EMPTY_TURN.join(""), EMPTY_TURN.join("")]);
		const guarded = createEmptyCompletionGuardFetch(inner);

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const text = await readAll(response);

		expect(inner).toHaveBeenCalledTimes(2);
		expect(text).toContain("event: error");
		expect(text).toContain("empty completion 2 times");
	});

	it("retries a non-streaming empty body and returns the good one", async () => {
		const empty = JSON.stringify({ status: "completed", output: [], usage: { total_tokens: 0 } });
		const good = JSON.stringify({ status: "completed", output: [{ type: "message" }], usage: { total_tokens: 12 } });
		const inner = vi
			.fn()
			.mockResolvedValueOnce(new Response(empty, { status: 200, headers: { "content-type": "application/json" } }))
			.mockResolvedValueOnce(new Response(good, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
		const guarded = createEmptyCompletionGuardFetch(inner);

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const body = (await response.json()) as { usage: { total_tokens: number } };

		expect(inner).toHaveBeenCalledTimes(2);
		expect(body.usage.total_tokens).toBe(12);
	});

	it("answers 502 with a readable error when a non-streaming retry is also empty", async () => {
		const empty = JSON.stringify({ status: "completed", output: [], usage: { total_tokens: 0 } });
		const inner = vi.fn(async () => new Response(empty, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
		const guarded = createEmptyCompletionGuardFetch(inner);

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });

		expect(response.status).toBe(502);
		expect(response.headers.get("x-wokey-empty-completion")).toBe("2");
		const body = (await response.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("empty_completion");
		expect(body.error.message).toMatch(/nothing was generated/i);
	});

	it("never retries a request the caller aborted", async () => {
		const inner = fakeStreamFetch([EMPTY_TURN.join("")]);
		const guarded = createEmptyCompletionGuardFetch(inner);
		const controller = new AbortController();
		controller.abort();

		await guarded(URL_RESPONSES, { method: "POST", body: "{}", signal: controller.signal });

		expect(inner).toHaveBeenCalledOnce();
	});

	it("leaves other routes and methods alone", async () => {
		const inner = fakeStreamFetch([EMPTY_TURN.join(""), EMPTY_TURN.join("")]);
		const guarded = createEmptyCompletionGuardFetch(inner);

		await guarded("https://api.wokey.ai/v1/messages", { method: "POST", body: "{}" });
		await guarded(URL_RESPONSES, { method: "GET" });

		expect(inner).toHaveBeenCalledTimes(2);
	});

	it("honours maxRetries: 0 by reporting the first empty completion", async () => {
		const inner = fakeStreamFetch([EMPTY_TURN.join("")]);
		const guarded = createEmptyCompletionGuardFetch(inner, { maxRetries: 0 });

		const response = await guarded(URL_RESPONSES, { method: "POST", body: "{}" });
		const text = await readAll(response);

		expect(inner).toHaveBeenCalledOnce();
		expect(text).toContain("event: error");
	});
});