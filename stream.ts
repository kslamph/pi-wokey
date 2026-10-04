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
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { WokeyConfig } from "./config.ts";
import { type WokeyRoute } from "./routes.ts";
/** Kept here so existing imports keep working; the implementation lives on the route. */
export { applyCodexEnvelope } from "./routes.ts";
import { createProbingFetch, type ProofReport } from "./verify/probe.ts";

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
 * Shape one call's options for a route: proof-mode headers stripped, session-keyed
 * route headers, the probing fetch when verification is on, and the caller
 * `onPayload` chained before the route policy. Everything else on the options
 * object (abort signal, timeout, env, onResponse, ...) passes through untouched.
 */
function buildRoutedOptions<T extends StreamOptions>(
	route: WokeyRoute,
	config: WokeyConfig,
	onReport: (report: ProofReport) => void,
	model: Model<Api>,
	options: T | undefined,
): T {
	const headers: Record<string, string | null> = { ...options?.headers };
	// The provider drives the proof transport, and the only delivery the probe can
	// verify is the relay's default trailing `event: tee.proof` SSE record. Drop a
	// caller-supplied proof-mode header so the relay cannot be asked for a transport
	// (e.g. multipart) that pi's streaming adapter cannot consume.
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === config.proofHeaderName.toLowerCase()) delete headers[key];
	}

	const upstream = options?.onPayload;
	// One cache key per conversation: pi supplies the session id, so fall back
	// to a process-wide key only when it is absent.
	const cacheKey = clampCacheKey(options?.sessionId ?? processCacheKey);
	const routedHeaders = route.transformHeaders(headers, cacheKey);

	// Built as the base shape, then cast: T only ever narrows StreamOptions with
	// per-API extras, and the spread above carries those through untouched.
	const routed: StreamOptions = {
		...options,
		// Credentials are pi-managed: pi resolves the key from its own store
		// (auth.json via `/login wokey`) before calling the
		// provider, so whatever it supplies passes through untouched and this
		// extension never reads a second key store.
		headers: routedHeaders,
		// The probe verifies against this route's policy. When verification is off
		// there is nothing to wrap, so pi (or the caller) supplies the transport.
		...(config.verify
			? {
					fetch: createProbingFetch({
						routeId: route.id,
						policy: { expectedPcr0: config.expectedPcr0, endpoint: route.endpoint, requestBinding: route.requestBinding },
						onReport,
						expectedModel: model.id,
						extractServedModel: route.extractServedModel,
					}),
				}
			: {}),
		// Chain rather than replace, so another extension's instrumentation still runs.
		onPayload: async (payload: unknown, m: Model<Api>) => {
			const replaced = upstream ? await upstream(payload, m) : undefined;
			const base = replaced ?? payload;
			return route.transformPayload(base, cacheKey);
		},
	};
	return routed as T;
}

/**
 * Wrap one route's native pi API implementation with verification.
 *
 * The caller supplies the already-resolved native `stream`/`streamSimple` pair
 * for `route.api`; the wrapper shapes requests through the route policy and
 * verifies responses with the route's trust policy. A model whose API does
 * not match the route is a programming error, so it throws — it never
 * silently runs through another API. Deferred entry points pass through only
 * when the injected native implementation provides them, guarded by the same
 * API check.
 */
export function createVerifiedStreams(
	route: WokeyRoute,
	config: WokeyConfig,
	onReport: (report: ProofReport) => void,
	native: ProviderStreams,
): ProviderStreams {
	const checkApi = (model: Model<Api>): void => {
		if (model.api !== route.api) {
			throw new Error(`wokey: unsupported API "${model.api}" for model "${model.id}" on route "${route.id}" (serves "${route.api}")`);
		}
	};
	return {
		stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream {
			checkApi(model);
			return native.stream(model, context, buildRoutedOptions(route, config, onReport, model, options));
		},
		streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
			checkApi(model);
			return native.streamSimple(model, context, buildRoutedOptions(route, config, onReport, model, options));
		},
		...(native.fetchDeferred
			? {
					fetchDeferred: (model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions): AssistantMessageEventStream => {
						checkApi(model);
						return native.fetchDeferred!(model, handle, options);
					},
				}
			: {}),
		...(native.cancelDeferred
			? {
					cancelDeferred: async (model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void> => {
						checkApi(model);
						await native.cancelDeferred!(model, handle, options);
					},
				}
			: {}),
	};
}
