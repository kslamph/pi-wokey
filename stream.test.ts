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
import { createWokeyStream } from "./stream.ts";

const model = { id: "gpt-6-luna", api: "openai-responses" } as never;
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
			const config = resolveConfig({ codexEnvelope: true });
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
		const config = resolveConfig({ codexEnvelope: true });
		createWokeyStream({ config, onReport: () => {} })(model, context, { apiKey: "caller-key", sessionId: "session-xyz" });

		const opts = lastOptions();
		expect(opts.apiKey).toBe("caller-key");

		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		expect((await onPayload({ a: 1 }, model)).prompt_cache_key).toBe("session-xyz");
		// Stable across turns of the same conversation.
		expect((await onPayload({ a: 2 }, model)).prompt_cache_key).toBe("session-xyz");
	});

	it("sends codex's session-id affinity header carrying the same key as the body", async () => {
		const config = resolveConfig({ codexEnvelope: true });
		createWokeyStream({ config, onReport: () => {} })(model, context, { sessionId: "session-xyz" });

		const opts = lastOptions();
		// Codex sends prompt_cache_key as the `session-id` header; both must be the same string.
		expect((opts.headers as Record<string, string>)["session-id"]).toBe("session-xyz");
		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		expect((await onPayload({ a: 1 }, model)).prompt_cache_key).toBe("session-xyz");
	});

	it("clamps a long session id identically in the header and the body", async () => {
		const long = "s".repeat(80);
		const config = resolveConfig({ codexEnvelope: true });
		createWokeyStream({ config, onReport: () => {} })(model, context, { sessionId: long });

		const opts = lastOptions();
		const header = (opts.headers as Record<string, string>)["session-id"];
		const onPayload = opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>;
		const body = (await onPayload({ a: 1 }, model)).prompt_cache_key;

		// pi truncates the body key at 64 chars; the header must match, not exceed it.
		expect(header).toBe("s".repeat(64));
		expect(header).toBe(body);
	});

	it("does not overwrite a caller-supplied session-id header", () => {
		const config = resolveConfig();
		createWokeyStream({ config, onReport: () => {} })(model, context, {
			sessionId: "session-xyz",
			headers: { "Session-Id": "caller-wins" } as never,
		});

		expect((lastOptions().headers as Record<string, string>)["Session-Id"]).toBe("caller-wins");
		expect((lastOptions().headers as Record<string, string>)["session-id"]).toBeUndefined();
	});

	it("chains a caller-supplied onPayload instead of replacing it", async () => {
		const config = resolveConfig({ codexEnvelope: false });
		const upstream = vi.fn(async (payload: unknown) => ({ ...(payload as object), upstream: true }));
		createWokeyStream({ config, onReport: () => {} })(model, context, { onPayload: upstream as never });

		const opts = lastOptions();
		const out = await (opts.onPayload as (p: unknown, m: unknown) => Promise<Record<string, unknown>>)({ a: 1 }, model);
		expect(upstream).toHaveBeenCalledOnce();
		expect(out.upstream).toBe(true);
	});
});