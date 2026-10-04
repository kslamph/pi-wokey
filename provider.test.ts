/**
 * The native Wokey provider: one `wokey` provider with pi-native auth,
 * per-route verified API implementations, and transactional catalog refresh.
 *
 * The native API factories are mocked so dispatch is observable without
 * touching the network: each fake records which route wrapper called it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { openAIStreams, anthropicStreams, completionsStreams } = vi.hoisted(() => ({
	openAIStreams: { stream: vi.fn((..._args: unknown[]) => ({}) as never), streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) },
	anthropicStreams: { stream: vi.fn((..._args: unknown[]) => ({}) as never), streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) },
	completionsStreams: { stream: vi.fn((..._args: unknown[]) => ({}) as never), streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) },
}));
// Mock the /compat entrypoint (the only pi-ai subpath Pi aliases into extensions —
// see the NOTE in provider.ts). One mock covers all three wire-API factories.
vi.mock("@earendil-works/pi-ai/compat", () => ({
	openAIResponsesApi: () => openAIStreams,
	anthropicMessagesApi: () => anthropicStreams,
	openAICompletionsApi: () => completionsStreams,
}));

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { fetchBalance, WOKEY_API_ROOT } from "./balance.ts";
import { resolveConfig } from "./config.ts";
import { createWokeyProvider, getLastCatalogWarnings, refreshWokeyModels } from "./provider.ts";

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
		completionsStreams.stream.mockClear();
		completionsStreams.streamSimple.mockClear();
	});

	it("registers one provider with id wokey", () => {
		const p = provider();
		expect(p.id).toBe("wokey");
		expect(p.name).toBe("wokey.ai");
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
			// Native API-key auth: pi resolves auth.json and offers `/login wokey`.
			// Absent = ambient-only, never a file write here.
			expect(p.auth.apiKey).toBeDefined();
			expect(p.auth.apiKey?.name).toBe("Wokey API key");
			expect(typeof p.auth.apiKey?.login).toBe("function");
			// Ambient auth is deliberately OFF: with no stored credential the
			// handler must resolve undefined even when WOKEY_API_KEY is exported.
			const ambient = await p.auth.apiKey?.resolve({
				ctx: { env: async (name: string) => (name === "WOKEY_API_KEY" ? "sk-from-env" : undefined) },
				credential: undefined,
				signal: { throwIfAborted() {} },
			} as never);
			expect(ambient).toBeUndefined();
			// The stored credential still resolves, and wins over any env value.
			const stored = await p.auth.apiKey?.resolve({
				ctx: { env: async () => "sk-from-env" },
				credential: { type: "api_key", key: "sk-from-auth-json" },
				signal: { throwIfAborted() {} },
			} as never);
			expect(stored?.auth.apiKey).toBe("sk-from-auth-json");
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

	it("serves a GPT→Claude switch from one provider id with one pi-managed credential", () => {
		const p = provider();
		const models = p.getModels();
		const gpt = models.find((m) => m.id === "gpt-6-luna")!;
		const claude = models.find((m) => m.id === "claude-opus-5-5")!;
		// One provider, one auth: the switch changes adapter and relay root,
		// never the provider id and never the credential (no re-login).
		expect(gpt.provider).toBe("wokey");
		expect(claude.provider).toBe("wokey");
		expect(p.auth.apiKey?.name).toBe("Wokey API key");
		expect(gpt.api).toBe("openai-responses");
		expect(claude.api).toBe("anthropic-messages");
		expect(gpt.baseUrl).not.toBe(claude.baseUrl);
		p.stream(gpt, context, {});
		p.stream(claude, context, {});
		expect(openAIStreams.stream).toHaveBeenCalledOnce();
		expect(anthropicStreams.stream).toHaveBeenCalledOnce();
	});

	it("surfaces an unsupported model api as a provider stream error, never an OpenAI fallback", async () => {
		const p = provider();
		const other = { provider: "wokey", id: "gpt-5.5", api: "openai-codex-responses" } as never;
		const events: unknown[] = [];
		for await (const event of p.stream(other, context, {})) events.push(event);
		const error = events.find((e) => (e as { type?: string }).type === "error");
		expect(error).toBeDefined();
		expect(JSON.stringify(error)).toMatch(/no API implementation.*openai-codex-responses/i);
		expect(openAIStreams.stream).not.toHaveBeenCalled();
		expect(anthropicStreams.stream).not.toHaveBeenCalled();
		expect(completionsStreams.stream).not.toHaveBeenCalled();
	});

	it("dispatches chat-completions models to the completions wrapper", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "wokey-provider-chat-"));
		const prev = process.env.WOKEY_CONFIG;
		// Opt into the unverified vendors the way the selector does.
		process.env.WOKEY_CONFIG = join(dir, "wokey.json");
		writeFileSync(process.env.WOKEY_CONFIG, JSON.stringify({ enabledModels: ["glm-5.3-flash"] }));
		try {
			const p = provider();
			const glm = p.getModels().find((m) => m.id === "glm-5.3-flash")!;
			expect(glm).toMatchObject({ api: "openai-completions", baseUrl: "https://api.wokey.ai/v1" });
			p.stream(glm, context, {});
			expect(completionsStreams.stream).toHaveBeenCalledOnce();
			expect(openAIStreams.stream).not.toHaveBeenCalled();
			expect(anthropicStreams.stream).not.toHaveBeenCalled();
		} finally {
			if (prev === undefined) delete process.env.WOKEY_CONFIG;
			else process.env.WOKEY_CONFIG = prev;
			rmSync(dir, { recursive: true, force: true });
		}
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

	it("keeps overlay warnings for the status panel and replaces them on the next success", async () => {
		stubFetch(() => ok({ data: [{ id: "no-such-model" }] }));
		await refreshWokeyModels(refreshContext());
		// The unknown id is ignored, but the missing active rows warn.
		expect(getLastCatalogWarnings().join("\n")).toContain("gpt-6.1-sol not listed upstream");

		stubFetch(() => ok({ data: [] }));
		await refreshWokeyModels(refreshContext());
		expect(getLastCatalogWarnings().join("\n")).toContain("gpt-6.1-sol not listed upstream");
	});

	it("leaves previous warnings in place when a refresh fails", async () => {
		stubFetch(() => ok({ data: [] }));
		await refreshWokeyModels(refreshContext());
		const before = getLastCatalogWarnings();
		expect(before.length).toBeGreaterThan(0);

		stubFetch(() => Promise.reject(new Error("relay down")));
		await refreshWokeyModels(refreshContext());
		expect(getLastCatalogWarnings()).toEqual(before);
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
