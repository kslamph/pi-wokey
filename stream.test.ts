/**
 * Wiring tests for `createWokeyStream` — the part of the product the probe
 * depends on. `applyCodexEnvelope` alone is pure and already covered; what was
 * untested is that the probing fetch, the proof-mode header and the apiKey
 * fallback actually reach pi's adapter, and that the envelope runs through the
 * chained `onPayload`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamSimple } = vi.hoisted(() => ({ streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ getApiProvider: () => ({ streamSimple }) }));

import { resolveConfig } from "./config.ts";
import { getRoute } from "./routes.ts";
import { createVerifiedStreams, createWokeyStream } from "./stream.ts";
import * as probeModule from "./verify/probe.ts";

const model = { id: "gpt-6-luna", api: "openai-responses" } as never;
const claudeModel = { id: "claude-opus-5-5", api: "anthropic-messages" } as never;
const context = { messages: [] } as never;

/** Last options object handed to the fake adapter. */
function lastOptions(): Record<string, unknown> {
	const call = streamSimple.mock.calls.at(-1)!;
	return call[2] as Record<string, unknown>;
}

describe("wokey streamSimple wiring", () => {
	beforeEach(() => streamSimple.mockClear());

	it("injects the probing fetch, the proof-mode header and the resolved key", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wokey-stream-"));
		const file = join(dir, "wokey.json");
		writeFileSync(file, JSON.stringify({ apiKey: "file-key" }));
		const prev = process.env.WOKEY_CONFIG;
		process.env.WOKEY_CONFIG = file;
		try {
			const config = resolveConfig();
			createWokeyStream({ config, onReport: () => {} })(model, context, {});

			const opts = lastOptions();
			expect(typeof opts.fetch).toBe("function");
			expect(opts.apiKey).toBe("file-key");
			// The provider drives the proof transport: it never asks for multipart.
			expect((opts.headers as Record<string, string>)[config.proofHeaderName]).toBeUndefined();

			// The chained onPayload must still apply the Codex envelope.
			const out = (await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)({ model: "gpt-6-luna" }, model));
			expect(out.store).toBe(false);
			expect(out.instructions).toBe("You are a helpful assistant.");
			expect(typeof out.prompt_cache_key).toBe("string");
		} finally {
			if (prev === undefined) delete process.env.WOKEY_CONFIG;
			else process.env.WOKEY_CONFIG = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips a caller-supplied proof-mode header so the relay stays on SSE", () => {
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, {
			headers: { "X-Wokey-Tee-Proof-Mode": "multipart", "x-other": "keep" } as never,
		});

		const headers = lastOptions().headers as Record<string, string>;
		expect(headers["X-Wokey-Tee-Proof-Mode"]).toBeUndefined();
		expect(headers["x-other"]).toBe("keep");
	});

	it("prefers a caller-supplied key and uses the session id as the cache key", async () => {
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, { apiKey: "caller-key", sessionId: "session-xyz" });

		const opts = lastOptions();
		expect(opts.apiKey).toBe("caller-key");

		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		expect((await onPayload({ a: 1 }, model)).prompt_cache_key).toBe("session-xyz");
		// Stable across turns of the same conversation.
		expect((await onPayload({ a: 2 }, model)).prompt_cache_key).toBe("session-xyz");
	});

	it("sends codex's session-id affinity header carrying the same key as the body", async () => {
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, { sessionId: "session-xyz" });

		const opts = lastOptions();
		// Codex sends prompt_cache_key as the `session-id` header; both must be the same string.
		expect((opts.headers as Record<string, string>)["session-id"]).toBe("session-xyz");
		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		expect((await onPayload({ a: 1 }, model)).prompt_cache_key).toBe("session-xyz");
	});

	it("clamps a long session id identically in the header and the body", async () => {
		const long = "s".repeat(80);
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, { sessionId: long });

		const opts = lastOptions();
		const header = (opts.headers as Record<string, string>)["session-id"];
		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		const body = (await onPayload({ a: 1 }, model)).prompt_cache_key;

		// pi truncates the body key at 64 chars; the header must match, not exceed it.
		expect(header).toBe("s".repeat(64));
		expect(header).toBe(body);
	});

	it("matches pi's Codex headers and suppresses the generic underscore header", () => {
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, {
			sessionId: "session-xyz",
			headers: { "Session-Id": "caller-wins", session_id: "generic-adapter" } as never,
		});

		const headers = lastOptions().headers as Record<string, string | null>;
		expect(headers["session-id"]).toBe("session-xyz");
		expect(headers["x-client-request-id"]).toBe("session-xyz");
		expect(headers["session_id"]).toBeNull();
		expect(headers["Session-Id"]).toBeUndefined();
	});

	it("chains a caller-supplied onPayload instead of replacing it", async () => {
		const config = resolveConfig();
		const upstream = vi.fn(async (payload: unknown) => ({ ...(payload as object), upstream: true }));
		createWokeyStream({ config, onReport: () => {} })(model, context, { onPayload: upstream as never });

		const opts = lastOptions();
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)({ a: 1 }, model);
		expect(upstream).toHaveBeenCalledOnce();
		expect(out.upstream).toBe(true);
		// The GPT route envelope still applies after the caller's hook.
		expect(out.store).toBe(false);
	});
});
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
