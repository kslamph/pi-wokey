/**
 * The native Wokey provider: one `wokey` provider with pi-native auth,
 * per-route verified API implementations, and transactional catalog refresh.
 *
 * The native API factories are mocked so dispatch is observable without
 * touching the network: each fake records which route wrapper called it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAIStreams, anthropicStreams } = vi.hoisted(() => ({
	openAIStreams: { stream: vi.fn((..._args: unknown[]) => ({}) as never), streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) },
	anthropicStreams: { stream: vi.fn((..._args: unknown[]) => ({}) as never), streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) },
}));
vi.mock("@earendil-works/pi-ai/api/openai-responses.lazy", () => ({ openAIResponsesApi: () => openAIStreams }));
vi.mock("@earendil-works/pi-ai/api/anthropic-messages.lazy", () => ({ anthropicMessagesApi: () => anthropicStreams }));

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { fetchBalance, WOKEY_API_ROOT } from "./balance.ts";
import { resolveConfig } from "./config.ts";
import { createWokeyProvider } from "./provider.ts";

const context = { messages: [] } as never;

/** Verification off: dispatch is what is under test, not the probe transport. */
function provider() {
	return createWokeyProvider({ config: resolveConfig({ verify: false }), onReport: () => {} });
}

function refreshContext(overrides?: Partial<RefreshModelsContext>): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "sk-test" },
		stored: undefined,
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
		...overrides,
	};
}

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
	vi.stubGlobal("fetch", spy);
	return spy;
}

function ok(body: unknown): Response {
	return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("native wokey provider identity", () => {
	beforeEach(() => {
		openAIStreams.stream.mockClear();
		openAIStreams.streamSimple.mockClear();
		anthropicStreams.stream.mockClear();
		anthropicStreams.streamSimple.mockClear();
	});

	it("registers one provider with id wokey", () => {
		const p = provider();
		expect(p.id).toBe("wokey");
		expect(p.name).toBe("wokey.ai (verified)");
	});

	it("declares native /login auth and stores no key in custom settings", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "wokey-provider-auth-"));
		const file = join(dir, "wokey.json");
		const prev = process.env.WOKEY_CONFIG;
		process.env.WOKEY_CONFIG = file;
		try {
			const p = provider();
			// Native API-key auth: pi resolves auth.json / WOKEY_API_KEY and
			// offers `/login wokey`. Absent = ambient-only, never a file write here.
			expect(p.auth.apiKey).toBeDefined();
			expect(p.auth.apiKey?.name).toBe("Wokey API key");
			expect(typeof p.auth.apiKey?.login).toBe("function");
			// Building the provider must not create a custom settings file.
			const { existsSync } = await import("node:fs");
			expect(existsSync(file)).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.WOKEY_CONFIG;
			else process.env.WOKEY_CONFIG = prev;
			const { rmSync } = await import("node:fs");
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns both GPT and Claude models with route-specific api and baseUrl", () => {
		const models = provider().getModels();
		const gpt = models.find((m) => m.id === "gpt-6-luna");
		const claude = models.find((m) => m.id === "claude-opus-5-5");
		expect(gpt).toMatchObject({ api: "openai-responses", baseUrl: "https://api.wokey.ai/v1" });
		expect(claude).toMatchObject({ api: "anthropic-messages", baseUrl: "https://api.wokey.ai" });
	});

	it("dispatches GPT models to the OpenAI wrapper and Claude to the Anthropic wrapper", () => {
		const p = provider();
		const models = p.getModels();
		const gpt = models.find((m) => m.id === "gpt-6-luna")!;
		const claude = models.find((m) => m.id === "claude-opus-5-5")!;
		p.stream(gpt, context, {});
		p.streamSimple(claude, context, {});
		expect(openAIStreams.stream).toHaveBeenCalledOnce();
		expect(anthropicStreams.streamSimple).toHaveBeenCalledOnce();
		expect(anthropicStreams.stream).not.toHaveBeenCalled();
		expect(openAIStreams.streamSimple).not.toHaveBeenCalled();
	});

	it("surfaces an unsupported model api as a provider stream error, never an OpenAI fallback", async () => {
		const p = provider();
		const other = { provider: "wokey", id: "gpt-5.5", api: "openai-completions" } as never;
		const events: unknown[] = [];
		for await (const event of p.stream(other, context, {})) events.push(event);
		const error = events.find((e) => (e as { type?: string }).type === "error");
		expect(error).toBeDefined();
		expect(JSON.stringify(error)).toMatch(/no API implementation.*openai-completions/i);
		expect(openAIStreams.stream).not.toHaveBeenCalled();
		expect(anthropicStreams.stream).not.toHaveBeenCalled();
	});
});

describe("native catalog refresh", () => {
	it("reads GET https://api.wokey.ai/v1/models with Bearer key and the caller abort signal", async () => {
		const controller = new AbortController();
		const spy = stubFetch(() => ok({ data: [] }));
		const p = provider();
		await p.refreshModels!(refreshContext({ signal: controller.signal }));
		expect(spy).toHaveBeenCalledWith(
			"https://api.wokey.ai/v1/models",
			expect.objectContaining({ headers: { authorization: "Bearer sk-test" }, signal: controller.signal }),
		);
		// An empty overlay leaves the baked-in lineup untouched.
		expect(p.getModels().map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"]);
	});

	it("retains the last-known catalog when the refresh fails", async () => {
		stubFetch(() => Promise.reject(new Error("relay down")));
		const p = provider();
		await expect(p.refreshModels!(refreshContext())).resolves.toBeUndefined();
		expect(p.getModels().map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"]);
	});

	it("skips the network call without a credential but still returns the known models", async () => {
		const spy = stubFetch(() => ok({ data: [] }));
		const p = provider();
		const models = await p.refreshModels!(refreshContext({ credential: undefined }));
		expect(spy).not.toHaveBeenCalled();
		expect(models).toBeUndefined();
		expect(p.getModels()).toHaveLength(4);
	});
});

describe("balance root", () => {
	it("uses the stable relay root with Bearer authentication", async () => {
		expect(WOKEY_API_ROOT).toBe("https://api.wokey.ai/v1");
		const spy = stubFetch(() => ok({ availableUsd: 10.787384, reservedUsd: 0 }));
		await fetchBalance(WOKEY_API_ROOT, "sk-test");
		expect(spy).toHaveBeenCalledWith(
			"https://api.wokey.ai/v1/dashboard/balance",
			expect.objectContaining({ headers: { authorization: "Bearer sk-test" } }),
		);
	});
});
