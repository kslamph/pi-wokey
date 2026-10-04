/**
 * Immutable Wokey route profiles.
 *
 * Every protocol-specific assumption lives here — never in user settings and
 * never scattered across the provider: which pi API implementation serves the
 * route, which relay base URL it uses, the exact measured `(host, path, method)`
 * tuple the enclave signs, whether byte-exact request binding is achievable,
 * how to shape requests, and how to read the served model back out of
 * integrity-bound response bytes.
 *
 * Trust anchors are code-pinned on purpose. A host or path is accepted only
 * after it has been measured against a real proof (see README §Adding an
 * upstream); nothing here is user-configurable, so a settings file cannot widen
 * what verification accepts.
 */

import { Buffer } from "node:buffer";

export type WokeyRouteId = "openai-codex" | "anthropic-direct";

export type WokeyApi = "openai-responses" | "anthropic-messages";

export interface WokeyEndpoint {
	host: string;
	path: string;
	method: "POST";
}

export interface WokeyRoute {
	id: WokeyRouteId;
	api: WokeyApi;
	/** Relay base URL for this route's protocol. */
	baseUrl: string;
	/** Exact signed upstream tuple. Host, path and method match as one unit. */
	endpoint: WokeyEndpoint;
	/**
	 * Whether byte-exact request binding is achievable through this relay.
	 *
	 * "unavailable": wokey rewrites the request body before the enclave sees it,
	 * so `request_body_sha256` commits to *its* body, never yours. The check is
	 * then reported as a known gap rather than a failure.
	 */
	requestBinding: "verify" | "unavailable";
	/** Served-model reader over the integrity-bound response bytes. */
	extractServedModel(body: Buffer): string | undefined;
	/** Route request policy, applied after the caller's `onPayload` hook. */
	transformPayload(payload: unknown, cacheKey: string): Record<string, unknown>;
	/** Route header policy for the given (already clamped) session cache key. */
	transformHeaders(headers: Record<string, string | null>, cacheKey: string): Record<string, string | null>;
}

/**
 * Shape the payload into the Codex Responses envelope. Only fills gaps —
 * anything pi already set (notably `reasoning`) is left untouched, so the
 * thinking level the user chose is never overwritten here.
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

/** Pull the upstream's self-reported model out of an SSE Responses stream. */
function extractResponsesServedModel(body: Buffer): string | undefined {
	const text = body.toString("utf8");
	for (const field of ["response.completed", "response.created"]) {
		const at = text.lastIndexOf(`event: ${field}`);
		if (at < 0) continue;
		const line = text.slice(at).split("\n").find((l) => l.startsWith("data:"));
		if (!line) continue;
		try {
			const parsed = JSON.parse(line.slice(5).trim());
			const model = parsed?.response?.model ?? parsed?.model;
			if (typeof model === "string") return model;
		} catch {
			/* keep scanning */
		}
	}
	return undefined;
}

/** Pull the served model out of an Anthropic SSE stream (`message_start.message.model`). */
function extractAnthropicServedModel(body: Buffer): string | undefined {
	const lines = body.toString("utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() !== "event: message_start") continue;
		// The data record follows the event line; collect its consecutive data:
		// lines (SSE joins them with "\n") until the next event or blank line.
		const data: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j]!;
			if (line.startsWith("data:")) data.push(line.slice(5).trim());
			else if (line.startsWith("event:") || line.trim() === "") break;
		}
		if (data.length === 0) continue;
		try {
			const model = JSON.parse(data.join("\n"))?.message?.model;
			if (typeof model === "string" && model) return model;
		} catch {
			/* keep scanning */
		}
	}
	return undefined;
}

/**
 * Match pi's `openai-codex-responses` header behavior. Its generic
 * `openai-responses` adapter would otherwise add `session_id` (underscore),
 * while Codex-compatible Responses uses the dashed `session-id` header.
 * Pi has no public thread-id in SimpleStreamOptions, so use its own Codex
 * provider's mapping: session-id and x-client-request-id both carry the
 * session/cache key, with no fabricated thread-id.
 */
function codexHeaders(headers: Record<string, string | null>, cacheKey: string): Record<string, string | null> {
	const out = { ...headers };
	for (const key of Object.keys(out)) {
		const lower = key.toLowerCase();
		if (lower === "session-id" || lower === "session_id" || lower === "x-client-request-id") delete out[key];
	}
	out["session_id"] = null; // suppress pi-ai's generic adapter default
	out["session-id"] = cacheKey;
	out["x-client-request-id"] = cacheKey;
	return out;
}

function freezeRoute(route: WokeyRoute): WokeyRoute {
	return Object.freeze({ ...route, endpoint: Object.freeze({ ...route.endpoint }) });
}

export const ROUTES: Readonly<Record<WokeyRouteId, WokeyRoute>> = Object.freeze({
	"openai-codex": freezeRoute({
		id: "openai-codex",
		api: "openai-responses",
		baseUrl: "https://api.wokey.ai/v1",
		endpoint: { host: "chatgpt.com", path: "/backend-api/codex/responses", method: "POST" },
		requestBinding: "unavailable",
		extractServedModel: extractResponsesServedModel,
		transformPayload: applyCodexEnvelope,
		transformHeaders: codexHeaders,
	}),
	"anthropic-direct": freezeRoute({
		id: "anthropic-direct",
		api: "anthropic-messages",
		baseUrl: "https://api.wokey.ai",
		endpoint: { host: "api.anthropic.com", path: "/v1/messages", method: "POST" },
		requestBinding: "unavailable",
		extractServedModel: extractAnthropicServedModel,
		// No plugin-added body transformation and no Codex headers: the Anthropic
		// Messages payload goes through exactly as pi's adapter built it (after
		// the caller's own onPayload hook) and carries no session-affinity headers.
		transformPayload: (payload) =>
			payload && typeof payload === "object" && !Array.isArray(payload)
				? { ...(payload as Record<string, unknown>) }
				: {},
		transformHeaders: (headers) => ({ ...headers }),
	}),
});

export function getRoute(id: WokeyRouteId): WokeyRoute {
	const route = ROUTES[id];
	if (!route) throw new Error(`wokey: unknown route "${id}"`);
	return route;
}
