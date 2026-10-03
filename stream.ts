/**
 * wokey's streamSimple.
 *
 * Adapter choice: `openai-responses`, not `openai-codex-responses`. The Codex
 * adapter authenticates as ChatGPT itself — it parses the key as a JWT for
 * `chatgpt_account_id` and sets `chatgpt-account-id` / `originator` headers
 * (openai-codex-responses.js:1272,1292). A wokey API key is not a JWT, so that
 * adapter hard-fails with "Failed to extract accountId from token". Those headers
 * are also wrong here: wokey's gateway injects its own subscription credentials,
 * so we must never claim a ChatGPT account id.
 *
 * What we *do* borrow is the Codex request envelope. The signed upstream path is
 * `/backend-api/codex/responses`, so that backend expects the shape its own client
 * sends. `applyCodexEnvelope` reproduces the fields from pi's codex adapter
 * (buildRequestBody, openai-codex-responses.js:389-431) so wokey has less to
 * translate — which is also the only route to recovering byte-exact request binding.
 */

import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { WokeyConfig } from "./config.ts";
import { resolveApiKey } from "./config.ts";
import { createProbingFetch, type ProofReport } from "./verify/probe.ts";

export interface WokeyStreamDeps {
	config: WokeyConfig;
	onReport(report: ProofReport): void;
}

/** Fallback cache key for calls that carry no session id: one per process. */
const processCacheKey = randomUUID();

/**
 * pi truncates `prompt_cache_key` to this length before sending it
 * (`OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH`, pi-ai `api/openai-prompt-cache.ts`). We mirror the
 * clamp so the `session-id` header and the body field carry the identical string, which is
 * what Codex does. Without it, a session id longer than 64 chars would disagree on the two.
 */
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

function clampCacheKey(key: string): string {
	const chars = Array.from(key);
	return chars.length <= PROMPT_CACHE_KEY_MAX_LENGTH ? key : chars.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Shape the payload into the Codex Responses envelope. Only fills gaps — anything
 * pi already set (notably `reasoning`) is left untouched, so the thinking level
 * the user chose is never overwritten here.
 */
export function applyCodexEnvelope(payload: unknown, cacheKey: string): Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
	const body = { ...(payload as Record<string, unknown>) };
	body.store = false; // the Codex backend rejects store:true outright
	if (typeof body.instructions !== "string" || body.instructions === "") {
		body.instructions = "You are a helpful assistant.";
	}
	if (!body.text || typeof body.text !== "object") body.text = { verbosity: "low" };
	if (!Array.isArray(body.include)) body.include = ["reasoning.encrypted_content"];
	if (typeof body.prompt_cache_key !== "string") body.prompt_cache_key = cacheKey;
	if (body.tool_choice === undefined) body.tool_choice = "auto";
	if (body.parallel_tool_calls === undefined) body.parallel_tool_calls = true;
	return body;
}

export function createWokeyStream(deps: WokeyStreamDeps) {
	const resolveImpl = (model: Model<Api>) => {
		const impl = getApiProvider(model.api) ?? getApiProvider("openai-responses") ?? getApiProvider("openai-completions");
		if (!impl) throw new Error("wokey: no openai-responses / openai-completions API provider registered in pi");
		return impl;
	};

	return function wokeyStreamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const impl = resolveImpl(model);

		const headers: Record<string, string | null> = { ...options?.headers };
		// The provider drives the proof transport, and the only delivery the probe can
		// verify is the relay's default trailing `event: tee.proof` SSE record. Drop a
		// caller-supplied proof-mode header so the relay cannot be asked for a transport
		// (e.g. multipart) that pi's streaming adapter cannot consume.
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === deps.config.proofHeaderName.toLowerCase()) delete headers[key];
		}

		const upstream = options?.onPayload;
		const envelope = deps.config.codexEnvelope;
		// One cache key per conversation: pi supplies the session id, so fall back
		// to a process-wide key only when it is absent.
		const cacheKey = clampCacheKey(options?.sessionId ?? processCacheKey);

		// Match pi's `openai-codex-responses` header behavior. Its generic
		// `openai-responses` adapter would otherwise add `session_id` (underscore),
		// while Codex-compatible Responses uses the dashed `session-id` header.
		// Pi has no public thread-id in SimpleStreamOptions, so use its own Codex
		// provider's mapping: session-id and x-client-request-id both carry the
		// session/cache key, with no fabricated thread-id.
		for (const key of Object.keys(headers)) {
			const lower = key.toLowerCase();
			if (lower === "session-id" || lower === "session_id" || lower === "x-client-request-id") delete headers[key];
		}
		headers["session_id"] = null; // suppress pi-ai's generic adapter default
		headers["session-id"] = cacheKey;
		headers["x-client-request-id"] = cacheKey;

		return impl.streamSimple(model, context, {
			...options,
			// pi supplies a key from its own credential store when it has one; otherwise
			// fall back to this extension's settings so `/wokey key <value>` is actually
			// sufficient on its own and does not require a second copy in auth.json.
			apiKey: options?.apiKey ?? resolveApiKey(),
			headers,
			fetch: createProbingFetch({ config: deps.config, onReport: deps.onReport, expectedModel: model.id }),
			// Chain rather than replace, so another extension's instrumentation still runs.
			onPayload: async (payload, m) => {
				const replaced = upstream ? await upstream(payload, m) : undefined;
				const base = replaced ?? payload;
				return envelope ? applyCodexEnvelope(base, cacheKey) : base;
			},
		});
	};
}