/**
 * Wiring tests for `createVerifiedStreams` — the per-route verified wrappers
 * behind the native Wokey provider. `applyCodexEnvelope` alone is pure and
 * already covered; what is tested here is that the probing fetch, the
 * proof-mode header and the apiKey fallback actually reach pi's adapter, and
 * that the envelope runs through the chained `onPayload`.
 *
 * (The legacy single-stream `createWokeyStream` was retired with the native
 * provider registration; its wiring is now covered through these wrappers.)
 */

import { describe, expect, it, vi } from "vitest";

import { calculateCost } from "@earendil-works/pi-ai";
import { resolveConfig } from "./config.ts";
import { activeSpecs, toModel } from "./models.ts";
import { getRoute } from "./routes.ts";
import { createVerifiedStreams } from "./stream.ts";
import * as probeModule from "./verify/probe.ts";

const model = { id: "gpt-6-luna", api: "openai-responses" } as never;
const claudeModel = { id: "claude-opus-5-5", api: "anthropic-messages" } as never;
const context = { messages: [] } as never;

/** Fresh mock of one route's native pi API implementation. */
function mockNative() {
	return {
		stream: vi.fn((..._args: unknown[]) => ({}) as never),
		streamSimple: vi.fn((..._args: unknown[]) => ({}) as never),
	};
}

type NativeMock = ReturnType<typeof mockNative>;

function nativeOptions(native: NativeMock, method: "stream" | "streamSimple"): Record<string, unknown> {
	const call = native[method].mock.calls.at(-1)!;
	return call[2] as Record<string, unknown>;
}

describe("createVerifiedStreams (GPT route)", () => {
	it("wraps both stream and streamSimple with a probing fetch", () => {
		const native = mockNative();
		const callerFetch = (async () => new Response()) as never;
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never);
		streams.stream(model, context, { fetch: callerFetch });
		streams.streamSimple(model, context, { fetch: callerFetch });

		expect(native.stream).toHaveBeenCalledOnce();
		expect(native.streamSimple).toHaveBeenCalledOnce();
		for (const method of ["stream", "streamSimple"] as const) {
			const opts = nativeOptions(native, method);
			expect(typeof opts.fetch).toBe("function");
			// Verification on: the probe owns the transport, not the caller.
			expect(opts.fetch).not.toBe(callerFetch);
		}
	});

	it("injects the route policy, expected model, and served-model reader", () => {
		const spy = vi.spyOn(probeModule, "createProbingFetch");
		try {
			const config = resolveConfig();
			const route = getRoute("openai-codex");
			createVerifiedStreams(route, config, () => {}, mockNative() as never).streamSimple(model, context, {});
			expect(spy).toHaveBeenCalledOnce();
			const deps = spy.mock.calls[0]![0];
			expect(deps.policy).toEqual({ expectedPcr0: config.expectedPcr0, endpoint: route.endpoint, requestBinding: route.requestBinding });
			expect(deps.expectedModel).toBe("gpt-6-luna");
			expect(deps.extractServedModel).toBe(route.extractServedModel);
		} finally {
			spy.mockRestore();
		}
	});

	it("runs the caller onPayload before the Codex envelope", async () => {
		const seen: unknown[] = [];
		const upstream = async (payload: unknown) => {
			seen.push(payload);
			return { ...(payload as object), upstream: true };
		};
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).streamSimple(model, context, { onPayload: upstream as never });

		const opts = nativeOptions(native, "streamSimple");
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)({ model: "gpt-6-luna" }, model);
		// The caller hook saw the raw pi payload, before the envelope.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ model: "gpt-6-luna" });
		// ...and the envelope still applies after it.
		expect(out.upstream).toBe(true);
		expect(out.store).toBe(false);
		expect(out.instructions).toBe("You are a helpful assistant.");
		expect(typeof out.prompt_cache_key).toBe("string");
	});

	it("sends Codex session headers carrying the same key as the body", async () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).stream(model, context, { sessionId: "session-xyz" });

		const opts = nativeOptions(native, "stream");
		expect((opts.headers as Record<string, string>)["session-id"]).toBe("session-xyz");
		expect((opts.headers as Record<string, string>)["x-client-request-id"]).toBe("session-xyz");
		expect((opts.headers as Record<string, string | null>)["session_id"]).toBeNull();
		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		expect((await onPayload({ a: 1 }, model)).prompt_cache_key).toBe("session-xyz");
	});

	it("strips proof-mode headers of any casing", () => {
		const config = resolveConfig();
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), config, () => {}, native as never).streamSimple(model, context, {
			headers: { "X-WOKEY-TEE-PROOF-MODE": "multipart", "x-other": "keep" } as never,
		});

		const headers = nativeOptions(native, "streamSimple").headers as Record<string, string>;
		expect(headers[config.proofHeaderName]).toBeUndefined();
		expect(headers["X-WOKEY-TEE-PROOF-MODE"]).toBeUndefined();
		expect(headers["x-other"]).toBe("keep");
	});

	it("passes a caller-provided API key through unchanged", () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).streamSimple(model, context, { apiKey: "caller-key" });
		expect(nativeOptions(native, "streamSimple").apiKey).toBe("caller-key");
	});

	it("adds no API key of its own — credentials are pi-managed", () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).streamSimple(model, context, {});
		expect(nativeOptions(native, "streamSimple").apiKey).toBeUndefined();
	});

	it("preserves caller onResponse, abort, timeout, and env", () => {
		const onResponse = vi.fn();
		const controller = new AbortController();
		const env = { HTTPS_PROXY: "http://proxy:8080" };
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).stream(model, context, {
			onResponse: onResponse as never,
			signal: controller.signal,
			timeoutMs: 1234,
			env,
		});

		const opts = nativeOptions(native, "stream");
		expect(opts.onResponse).toBe(onResponse);
		expect(opts.signal).toBe(controller.signal);
		expect(opts.timeoutMs).toBe(1234);
		expect(opts.env).toBe(env);
	});

	it("throws on an API mismatch instead of falling back", () => {
		const native = mockNative();
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never);
		expect(() => streams.streamSimple(claudeModel, context, {})).toThrowError(/unsupported.*anthropic-messages/i);
		expect(() => streams.stream(claudeModel, context, {})).toThrowError(/unsupported.*anthropic-messages/i);
		expect(native.stream).not.toHaveBeenCalled();
		expect(native.streamSimple).not.toHaveBeenCalled();
	});

	it("leaves the caller fetch alone when verification is off", () => {
		const callerFetch = (async () => new Response()) as never;
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig({ verify: false }), () => {}, native as never).streamSimple(model, context, { fetch: callerFetch });
		expect(nativeOptions(native, "streamSimple").fetch).toBe(callerFetch);
	});
});

describe("createVerifiedStreams (Anthropic route)", () => {
	it("wraps both stream and streamSimple with the Anthropic verification policy", () => {
		const spy = vi.spyOn(probeModule, "createProbingFetch");
		try {
			const config = resolveConfig();
			const route = getRoute("anthropic-direct");
			const native = mockNative();
			const streams = createVerifiedStreams(route, config, () => {}, native as never);
			streams.stream(claudeModel, context, {});
			streams.streamSimple(claudeModel, context, {});

			expect(native.stream).toHaveBeenCalledOnce();
			expect(native.streamSimple).toHaveBeenCalledOnce();
			expect(spy).toHaveBeenCalledTimes(2);
			for (const call of spy.mock.calls) {
				const deps = call[0];
				expect(deps.policy).toEqual({ expectedPcr0: config.expectedPcr0, endpoint: route.endpoint, requestBinding: route.requestBinding });
				expect(deps.expectedModel).toBe("claude-opus-5-5");
				expect(deps.extractServedModel).toBe(route.extractServedModel);
			}
			for (const method of ["stream", "streamSimple"] as const) {
				expect(typeof nativeOptions(native, method).fetch).toBe("function");
			}
		} finally {
			spy.mockRestore();
		}
	});

	it("passes the payload through unchanged after the caller hook", async () => {
		const seen: unknown[] = [];
		const upstream = async (payload: unknown) => {
			seen.push(payload);
			return { ...(payload as object), upstream: true };
		};
		const native = mockNative();
		createVerifiedStreams(getRoute("anthropic-direct"), resolveConfig(), () => {}, native as never).streamSimple(claudeModel, context, { onPayload: upstream as never });

		const input = { model: "claude-opus-5-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] };
		const opts = nativeOptions(native, "streamSimple");
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)(input, claudeModel);
		// The caller hook saw the raw pi payload.
		expect(seen).toEqual([input]);
		// No Codex envelope: exactly what the caller hook returned, nothing added.
		expect(out).toEqual({ ...input, upstream: true });
		expect(out).not.toHaveProperty("store");
		expect(out).not.toHaveProperty("instructions");
		expect(out).not.toHaveProperty("prompt_cache_key");
	});

	it("adds no Codex headers", () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("anthropic-direct"), resolveConfig(), () => {}, native as never).stream(claudeModel, context, {
			sessionId: "session-xyz",
			headers: { "x-other": "keep" } as never,
		});

		const headers = nativeOptions(native, "stream").headers as Record<string, string | null>;
		expect(headers).toEqual({ "x-other": "keep" });
	});

	it("strips proof-mode headers", () => {
		const config = resolveConfig();
		const native = mockNative();
		createVerifiedStreams(getRoute("anthropic-direct"), config, () => {}, native as never).streamSimple(claudeModel, context, {
			headers: { "X-Wokey-Tee-Proof-Mode": "multipart", "x-other": "keep" } as never,
		});

		const headers = nativeOptions(native, "streamSimple").headers as Record<string, string>;
		expect(headers[config.proofHeaderName]).toBeUndefined();
		expect(headers["X-Wokey-Tee-Proof-Mode"]).toBeUndefined();
		expect(headers["x-other"]).toBe("keep");
	});

	it("passes a caller-provided API key through unchanged and preserves hooks", () => {
		const onResponse = vi.fn();
		const controller = new AbortController();
		const native = mockNative();
		createVerifiedStreams(getRoute("anthropic-direct"), resolveConfig(), () => {}, native as never).stream(claudeModel, context, {
			apiKey: "caller-key",
			onResponse: onResponse as never,
			signal: controller.signal,
			timeoutMs: 1234,
		});

		const opts = nativeOptions(native, "stream");
		expect(opts.apiKey).toBe("caller-key");
		expect(opts.onResponse).toBe(onResponse);
		expect(opts.signal).toBe(controller.signal);
		expect(opts.timeoutMs).toBe(1234);
	});

	it("throws on an API mismatch instead of falling back to OpenAI", () => {
		const native = mockNative();
		const streams = createVerifiedStreams(getRoute("anthropic-direct"), resolveConfig(), () => {}, native as never);
		expect(() => streams.streamSimple(model, context, {})).toThrowError(/unsupported.*openai-responses/i);
		expect(() => streams.stream(model, context, {})).toThrowError(/unsupported.*openai-responses/i);
		expect(native.stream).not.toHaveBeenCalled();
		expect(native.streamSimple).not.toHaveBeenCalled();
	});
});

describe("createVerifiedStreams deferred passthrough", () => {
	const handle = { id: "deferred-1" } as never;

	it("passes fetchDeferred/cancelDeferred through with the same API check", async () => {
		const native = {
			...mockNative(),
			fetchDeferred: vi.fn((..._args: unknown[]) => ({}) as never),
			cancelDeferred: vi.fn(async (..._args: unknown[]) => {}),
		};
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never);
		streams.fetchDeferred!(model, handle, {});
		await streams.cancelDeferred!(model, handle, {});
		expect(native.fetchDeferred).toHaveBeenCalledOnce();
		expect(native.cancelDeferred).toHaveBeenCalledOnce();
		expect(() => streams.fetchDeferred!(claudeModel, handle, {})).toThrowError(/unsupported.*anthropic-messages/i);
		await expect(streams.cancelDeferred!(claudeModel, handle, {})).rejects.toThrowError(/unsupported.*anthropic-messages/i);
		expect(native.fetchDeferred).toHaveBeenCalledOnce();
		expect(native.cancelDeferred).toHaveBeenCalledOnce();
	});

	it("omits deferred entry points when the native implementation lacks them", () => {
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, mockNative() as never);
		expect(streams.fetchDeferred).toBeUndefined();
		expect(streams.cancelDeferred).toBeUndefined();
	});
});

describe("cross-protocol proof-wrapper parity", () => {
	const cases: { routeId: "openai-codex" | "anthropic-direct"; model: { id: string } }[] = [
		{ routeId: "openai-codex", model },
		{ routeId: "anthropic-direct", model: claudeModel },
	];

	it("installs each route's own endpoint tuple, expected model, and served-model reader on both stream and streamSimple", () => {
		for (const c of cases) {
			const spy = vi.spyOn(probeModule, "createProbingFetch");
			try {
				const config = resolveConfig();
				const route = getRoute(c.routeId);
				const native = mockNative();
				const streams = createVerifiedStreams(route, config, () => {}, native as never);
				streams.stream(c.model as never, context, {});
				streams.streamSimple(c.model as never, context, {});

				expect(spy).toHaveBeenCalledTimes(2);
				for (const call of spy.mock.calls) {
					expect(call[0].policy.endpoint).toEqual(route.endpoint);
					expect(call[0].expectedModel).toBe(c.model.id);
					expect(call[0].extractServedModel).toBe(route.extractServedModel);
				}
			} finally {
				spy.mockRestore();
			}
		}
		// ...and the two tuples are actually different policies, not one shared.
		expect(getRoute("openai-codex").endpoint).not.toEqual(getRoute("anthropic-direct").endpoint);
	});

	it("keeps Anthropic tool calls, thinking signatures, and cache usage byte-identical", async () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("anthropic-direct"), resolveConfig(), () => {}, native as never).streamSimple(claudeModel, context, {});

		const opts = nativeOptions(native, "streamSimple");
		const payload = {
			model: "claude-opus-5-5",
			max_tokens: 1024,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "get_time", description: "d", input_schema: { type: "object", properties: {} } }],
			thinking: { type: "enabled", budget_tokens: 10000 },
		};
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)(payload, claudeModel);
		// No envelope, no renames: thinking signatures and tool blocks reach the
		// adapter exactly as pi built them, so verification strips nothing semantic.
		expect(out).toEqual(payload);
		expect(out).not.toBe(payload);
	});

	it("keeps caller-set GPT reasoning effort through the Codex envelope", async () => {
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).streamSimple(model, context, {});

		const opts = nativeOptions(native, "streamSimple");
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)(
			{ model: "gpt-6-luna", reasoning: { effort: "xhigh" } },
			model,
		);
		// The envelope fills gaps only; the chosen thinking level survives.
		expect(out.reasoning).toEqual({ effort: "xhigh" });
		expect(out.store).toBe(false);
	});
});

describe("live pricing overlay", () => {
	// A session model captured before a catalog refresh: peak/off-peak moved on,
	// but the session still points at these numbers.
	const staleLuna = () =>
		({
			id: "gpt-6-luna",
			api: "openai-responses",
			cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
			contextWindow: 1,
			maxTokens: 2,
		}) as never;

	it("re-prices a stale session model at the current catalog rates", () => {
		const native = mockNative();
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never);
		const stale = staleLuna();
		streams.stream(stale, context, {});
		streams.streamSimple(stale, context, {});

		for (const method of ["stream", "streamSimple"] as const) {
			const sent = native[method].mock.calls[0]![0] as Record<string, unknown>;
			expect(sent).not.toBe(stale);
			expect(sent.cost).toEqual({ input: 0.09, output: 0.45, cacheRead: 0.009, cacheWrite: 0.1125 });
			expect(sent.contextWindow).toBe(1_050_000);
			expect(sent.maxTokens).toBe(128_000);
		}
		// The session's own object is never mutated.
		expect((stale as unknown as Record<string, unknown>).cost).toEqual({ input: 999, output: 999, cacheRead: 999, cacheWrite: 999 });
	});

	it("records the live rate into usage cost, not the stale one", () => {
		const seen: number[] = [];
		const native = {
			...mockNative(),
			stream: vi.fn((m: unknown) => {
				const usage = {
					input: 1_000_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_000_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				// What pi-ai's adapters do with the model they are handed.
				calculateCost(m as never, usage as never);
				seen.push(usage.cost.total);
				return {} as never;
			}),
		};
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).stream(staleLuna(), context, {});
		// 1M input tokens at the live $0.09/1M — not $999.
		expect(seen).toEqual([0.09]);
	});

	it("passes an already-current model through by identity", () => {
		const current = toModel(activeSpecs().find((s) => s.id === "gpt-6-luna")!);
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).stream(current as never, context, {});
		expect(native.stream.mock.calls[0]![0]).toBe(current);
	});

	it("passes an unknown model id through by identity", () => {
		const custom = { id: "custom-thing", api: "openai-responses", cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } as never;
		const native = mockNative();
		createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native as never).streamSimple(custom, context, {});
		expect(native.streamSimple.mock.calls[0]![0]).toBe(custom);
	});

	it("re-prices deferred fetches too", () => {
		const fetchDeferred = vi.fn((..._args: unknown[]) => ({}) as never);
		const native = { ...mockNative(), fetchDeferred } as never;
		const streams = createVerifiedStreams(getRoute("openai-codex"), resolveConfig(), () => {}, native);
		streams.fetchDeferred!(staleLuna(), { id: "deferred-1" } as never, {});
		expect((fetchDeferred.mock.calls[0]![0] as Record<string, unknown>).cost).toEqual({
			input: 0.09,
			output: 0.45,
			cacheRead: 0.009,
			cacheWrite: 0.1125,
		});
	});
});
