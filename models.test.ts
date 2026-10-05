import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateCost, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { GPT_MODELS, CLAUDE_MODELS, COMPLETIONS_MODELS, activeModels, activeSpecs, allSpecs, enabledModelIds, livePricingFor, refreshFromCatalog, toModel } from "./models.ts";
import { getRoute } from "./routes.ts";

// refreshFromCatalog reconciles the baked-in table in place against the live
// catalog, so restore it after every case rather than hand-restoring inline.
const snapshot = () => ({
	gpt: GPT_MODELS.map((m) => ({ ...m })),
	claude: CLAUDE_MODELS.map((m) => ({ ...m })),
	chat: COMPLETIONS_MODELS.map((m) => ({ ...m })),
	opus: activeSpecs().find((s) => s.id === "claude-opus-5-5") ? { ...activeSpecs().find((s) => s.id === "claude-opus-5-5")! } : undefined,
});
/** The Opus 5.5 spec, narrowed to its Anthropic variant (throws if it ever leaves its route). */
const opusSpec = () => {
	const s = activeSpecs().find((x) => x.id === "claude-opus-5-5")!;
	if (s.route !== "anthropic-direct") throw new Error("claude-opus-5-5 left the anthropic-direct route");
	return s;
};
let before: ReturnType<typeof snapshot>;
beforeEach(() => {
	before = snapshot();
});
afterEach(() => {
	before.gpt.forEach((s, i) => Object.assign(GPT_MODELS[i]!, s));
	before.claude.forEach((s, i) => Object.assign(CLAUDE_MODELS[i]!, s));
	before.chat.forEach((s, i) => Object.assign(COMPLETIONS_MODELS[i]!, s));
	if (before.opus) {
		const live = activeSpecs().find((s) => s.id === "claude-opus-5-5");
		if (live) Object.assign(live, before.opus);
	}
});

describe("route-aware models", () => {
	it("resolves GPT models to openai-responses and the GPT base URL", () => {
		for (const spec of activeSpecs().filter((s) => s.route === "openai-codex")) {
			const model = toModel(spec);
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://api.wokey.ai/v1");
			expect(model.provider).toBe("wokey");
		}
	});

	it("resolves claude-opus-5-5 to anthropic-messages and https://api.wokey.ai", () => {
		const spec = activeSpecs().find((s) => s.id === "claude-opus-5-5")!;
		expect(spec).toBeDefined();
		expect(spec.route).toBe("anthropic-direct");
		const model = toModel(spec);
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.wokey.ai");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
	});

	it("pins the exact Opus 5.5 thinking map and Anthropic compatibility flags", () => {
		const model = toModel(activeSpecs().find((s) => s.id === "claude-opus-5-5")!);
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(model.compat).toEqual({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			supportsStrictTools: true,
		});
		expect(model.promptCache).toEqual({ short: 300, long: 3600 });
	});

	it("pins Opus 5.5 Wokey rates", () => {
		const spec = activeSpecs().find((s) => s.id === "claude-opus-5-5")!;
		expect({ input: spec.input, output: spec.output, cacheRead: spec.cacheRead, cacheWrite: spec.cacheWrite }).toEqual({
			input: 0.6,
			output: 3.0,
			cacheRead: 0.03,
			cacheWrite: 0.75,
		});
		const model = toModel(spec);
		expect(model.cost.input).toBe(0.6);
		expect(model.cost.output).toBe(3.0);
		expect(model.cost.cacheRead).toBe(0.03);
		expect(model.cost.cacheWrite).toBe(0.75);
	});

	it("lets GPT and Claude models coexist in one activeModels() result", () => {
		const models = activeModels();
		expect(models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"]);
		expect(models.map((m) => m.api).sort()).toEqual(["anthropic-messages", "openai-responses", "openai-responses", "openai-responses"]);
		const opus = models.find((m) => m.id === "claude-opus-5-5")!;
		expect(getSupportedThinkingLevels(opus as never)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("activates exactly one Anthropic model", () => {
		expect(activeSpecs().filter((s) => s.route === "anthropic-direct").map((s) => s.id)).toEqual(["claude-opus-5-5"]);
	});
});

describe("catalog reconciliation", () => {
	it("adopts a larger context window and real rates", () => {
		const { updated } = refreshFromCatalog({
			data: [{ id: "gpt-6-sol", context_length: 2_000_000, max_completion_tokens: 64_000, pricing: { prompt: "0.0000005", completion: "0.0000025" } }],
		});
		expect(updated).toEqual(["gpt-6-sol"]);
		const m = GPT_MODELS.find((x) => x.id === "gpt-6-sol")!;
		expect(m.contextWindow).toBe(2_000_000);
		expect(m.maxTokens).toBe(64_000);
		expect(m.input).toBe(0.5);
		expect(m.output).toBe(2.5);
	});

	it("never shrinks a context window or zeroes a rate on a sparse response", () => {
		refreshFromCatalog({ data: [{ id: "gpt-6-sol", context_length: 1, pricing: {} }] });
		const m = GPT_MODELS.find((x) => x.id === "gpt-6-sol")!;
		expect(m.contextWindow).toBe(1_050_000);
		expect(m.input).toBe(0.18);
	});

	it("updates prices, context, and max output for known ids only", () => {
		const { updated } = refreshFromCatalog({
			data: [
				{ id: "claude-opus-5-5", context_length: 2_000_000, max_completion_tokens: 64_000, pricing: { prompt: "0.0000006" } },
				{ id: "claude-future-9", context_length: 9_999_999, max_completion_tokens: 9_999, pricing: { prompt: "0.0000001", completion: "0.0000002" } },
			],
		});
		expect(updated).toEqual(["claude-opus-5-5"]);
		const opus = activeSpecs().find((s) => s.id === "claude-opus-5-5")!;
		expect(opus.contextWindow).toBe(2_000_000);
		expect(opus.maxTokens).toBe(64_000);
		expect(activeSpecs().some((s) => s.id === "claude-future-9")).toBe(false);
		expect(activeModels().some((m) => m.id === "claude-future-9")).toBe(false);
	});

	it("never lets a catalog entry change route, API, thinking map, or compat", () => {
		refreshFromCatalog({
			data: [
				{
					id: "claude-opus-5-5",
					route: "openai-codex",
					api: "openai-responses",
					thinkingLevelMap: { off: "none", low: "low" },
					compat: { forceAdaptiveThinking: false, supportsTemperature: true },
					context_length: 2_000_000,
					pricing: { prompt: "0.0000006" },
				},
			],
		});
		const opus = opusSpec();
		// Numeric facts may move; policy must not.
		expect(opus.contextWindow).toBe(2_000_000);
		expect(opus.route).toBe("anthropic-direct");
		expect(opus.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(opus.compat).toEqual({
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			supportsStrictTools: true,
		});
		expect(toModel(opus).api).toBe("anthropic-messages");
	});

	it("parses input_cache_write_1h for validation without adopting it as a rate", () => {
		// 1.2/1M is exactly 2× the 0.60 input rate: consistent, so no warning.
		const { warnings } = refreshFromCatalog({
			data: [
				{
					id: "claude-opus-5-5",
					pricing: {
						prompt: "0.0000006",
						completion: "0.000003",
						input_cache_read: "0.00000003",
						input_cache_write: "0.00000075",
						input_cache_write_1h: "0.0000012",
					},
				},
			],
		});
		expect(warnings.filter((w) => w.includes("1h"))).toHaveLength(0);
		// The 1h figure is never stored: pi's calculateCost prices 1h writes at
		// native 2× input on top of the base cacheWrite rate.
		expect(activeSpecs().find((s) => s.id === "claude-opus-5-5")!.cacheWrite).toBe(0.75);
	});

	it("warns when the 1h cache-write rate diverges from native 2×input", () => {
		const { warnings } = refreshFromCatalog({
			data: [{ id: "claude-opus-5-5", pricing: { input_cache_write_1h: "0.000005" } }],
		});
		expect(warnings.some((w) => w.includes("claude-opus-5-5") && w.includes("1h"))).toBe(true);
		expect(activeSpecs().find((s) => s.id === "claude-opus-5-5")!.cacheWrite).toBe(0.75);
	});

	it("ignores malformed, absent, zero, and negative pricing without erasing baked-in rates", () => {
		refreshFromCatalog({
			data: [{ id: "claude-opus-5-5", pricing: { prompt: "not-a-number", completion: "", input_cache_read: "0", input_cache_write: "-0.0000005" } }],
		});
		const opus = activeSpecs().find((s) => s.id === "claude-opus-5-5")!;
		expect({ input: opus.input, output: opus.output, cacheRead: opus.cacheRead, cacheWrite: opus.cacheWrite }).toEqual({
			input: 0.6,
			output: 3.0,
			cacheRead: 0.03,
			cacheWrite: 0.75,
		});
		refreshFromCatalog({ data: [{ id: "claude-opus-5-5" }] });
		expect(activeSpecs().find((s) => s.id === "claude-opus-5-5")!.input).toBe(0.6);
	});

	it("warns when an active model is missing upstream", () => {
		const { warnings } = refreshFromCatalog({ data: [{ id: "something-else" }] });
		expect(warnings.some((w) => w.includes("gpt-6.1-sol"))).toBe(true);
	});

	it("does not warn about retired rows that are absent upstream", () => {
		const { warnings } = refreshFromCatalog({ data: [{ id: "something-else" }] });
		expect(warnings.some((w) => w.includes("gpt-6-sol"))).toBe(false);
		expect(warnings.some((w) => w.includes("gpt-5.5"))).toBe(false);
	});

	it("reports only ids whose values actually changed", () => {
		const catalog = {
			data: [{ id: "gpt-6-luna", context_length: 2_000_000, max_completion_tokens: 64_000, pricing: { prompt: "0.0000005", completion: "0.0000025" } }],
		};
		expect(refreshFromCatalog(catalog).updated).toEqual(["gpt-6-luna"]);
		// A second identical read must be a no-op, so startup does not churn the
		// provider registration.
		expect(refreshFromCatalog(catalog).updated).toEqual([]);
	});

	it("survives a malformed catalog", () => {
		expect(refreshFromCatalog(null).warnings).toHaveLength(1);
		expect(refreshFromCatalog({ data: "nope" }).warnings).toHaveLength(1);
	});
});

describe("live pricing", () => {
	it("reads the current spec rates for a known id", () => {
		expect(livePricingFor("deepseek-v4-flash")).toEqual({
			input: 0.112,
			output: 0.448,
			cacheRead: 0.00224,
			cacheWrite: 0,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
	});

	it("tracks a peak/off-peak swing the moment the catalog moves", () => {
		refreshFromCatalog({ data: [{ id: "deepseek-v4-flash", pricing: { prompt: "0.000000224", completion: "0.000000896" } }] });
		expect(livePricingFor("deepseek-v4-flash")).toMatchObject({ input: 0.224, output: 0.896 });
	});

	it("returns undefined for an id this provider does not know", () => {
		expect(livePricingFor("custom-thing")).toBeUndefined();
	});
});

describe("cost rates", () => {
	// Regression guard. `ModelCost` rates are USD per 1M tokens — pi-ai's
	// calculateCost() does the /1e6 itself. toModel() used to pre-divide as
	// well, so every message recorded cost 1e6x too small and any cost
	// readout showed $0.00000. Pin the unit, then pin the money.
	it("declares rates in USD per 1M, the unit pi's catalog uses", () => {
		const sol = toModel(activeSpecs().find((s) => s.id === "gpt-6.1-sol")!);
		expect(sol.cost).toEqual({ input: 0.18, output: 0.9, cacheRead: 0.009, cacheWrite: 0.225 });
	});

	it("turns a real message's usage into the right number of dollars", () => {
		const sol = toModel(activeSpecs().find((s) => s.id === "gpt-6.1-sol")!);
		const usage = {
			input: 556,
			output: 302,
			cacheRead: 181_760,
			cacheWrite: 0,
			totalTokens: 182_618,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(sol as never, usage);
		// 0.18*556 + 0.9*302 + 0.009*181760, all per 1M.
		expect(usage.cost.total).toBeCloseTo(0.00200772, 10);
		expect(usage.cost.total).toBeGreaterThan(0.01 / 100); // not a 1e-6 artifact
	});

	it("keeps every active row's rates equal to its spec rates", () => {
		for (const spec of activeSpecs()) {
			const model = toModel(spec);
			expect(model.cost.input).toBe(spec.input);
			expect(model.cost.output).toBe(spec.output);
			expect(model.cost.cacheRead).toBe(spec.cacheRead);
			expect(model.cost.cacheWrite).toBe(spec.cacheWrite);
		}
	});

	it("prices Anthropic 1h cache writes at native 2×input on top of base cacheWrite", () => {
		const opus = toModel(activeSpecs().find((s) => s.id === "claude-opus-5-5")!);
		const usage = {
			input: 1000,
			output: 500,
			cacheRead: 2000,
			cacheWrite: 1000,
			cacheWrite1h: 400,
			totalTokens: 4500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(opus as never, usage);
		// 600 short-write tokens at 0.75 plus 400 long-write tokens at 2×0.60,
		// all per 1M — pi's native split, not a stored 1h rate.
		expect(usage.cost.cacheWrite).toBeCloseTo((0.75 * 600 + 1.2 * 400) / 1_000_000, 12);
	});
});

describe("config", () => {
	it("points at the API host, not the website", () => {
		expect(getRoute("openai-codex").baseUrl).toBe("https://api.wokey.ai/v1");
	});

	it("serves the Anthropic route from the bare API host", () => {
		expect(getRoute("anthropic-direct").baseUrl).toBe("https://api.wokey.ai");
	});
});

describe("active lineup", () => {
	it("exposes the GPT-6 generation plus Claude Opus 5.5", () => {
		expect(activeModels().map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"]);
	});

	it("matches the OpenAI model cards", () => {
		const specs = Object.fromEntries(
			activeSpecs()
				.filter((s) => s.route === "openai-codex")
				.map((m) => [m.id, m.reasoningEfforts]),
		);
		expect(specs["gpt-6.1-sol"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(specs["gpt-6-astra"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(specs["gpt-6-luna"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("full Claude lineup", () => {
	// Price-advantaged rows only: dominated siblings (Opus 5/4.x, Sonnet 5/4.x,
	// Haiku 4.5, Fable 5) stay in CLAUDE_MODELS as paused reference data.
	const ids = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];

	it("lists the three kept Claude rows for the selector on the verified Messages route", () => {
		const specs = allSpecs().filter((s) => s.vendor === "Anthropic");
		expect(specs.map((s) => s.id)).toEqual(ids);
		for (const s of specs) expect(s.route).toBe("anthropic-direct");
	});

	it("borrows pi-native thinking maps and compat per row", () => {
		const byId = Object.fromEntries(allSpecs().map((s) => [s.id, s]));
		// Sonnet 5.5 has no pi entry anywhere: mirrors Sonnet 5 (see the spec
		// comment), so pin the borrowed shape explicitly.
		expect(toModel(byId["claude-sonnet-5-5"]!).thinkingLevelMap).toEqual({
			off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max",
		});
		expect(toModel(byId["claude-opus-5-5"]!).compat).toMatchObject({
			forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true,
		});
	});

	it("uses Wokey's own windows and text-vs-image per row, not pi's", () => {
		const byId = Object.fromEntries(allSpecs().map((s) => [s.id, toModel(s)]));
		expect(byId["claude-opus-5-5"]!.input).toEqual(["text", "image"]);
		expect(byId["claude-sonnet-5-5"]!.input).toEqual(["text", "image"]);
		expect(byId["claude-fable-5-1"]!.input).toEqual(["text", "image"]);
	});

	it("carries Wokey's rates with the 5m cache-write convention", () => {
		const byId = Object.fromEntries(allSpecs().map((s) => [s.id, toModel(s)]));
		expect(byId["claude-fable-5-1"]!.cost).toMatchObject({ input: 2.39, output: 11.95, cacheRead: 0.05975, cacheWrite: 2.9875 });
	});
});

describe("chat-completions vendors", () => {	it("lists Zhipu, MiniMax and DeepSeek rows for the selector, verified lineup first", () => {
		const ids = allSpecs().map((s) => s.id);
		for (const id of ["glm-5.3", "glm-5.3-flash", "MiniMax-M3", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"]) {
			expect(ids).toContain(id);
		}
		// Verified lineup stays ahead of the opt-in vendors.
		expect(ids.indexOf("claude-opus-5-5")).toBeLessThan(ids.indexOf("glm-5.3"));
		const vendors = Object.fromEntries(allSpecs().map((s) => [s.id, s.vendor]));
		expect(vendors["glm-5.3-flash"]).toBe("Zhipu");
		expect(vendors["MiniMax-M3"]).toBe("MiniMax");
		expect(vendors["deepseek-v4-pro"]).toBe("DeepSeek");
	});

	it("resolves GLM to openai-completions with pi's zai thinking map and compat", () => {
		const model = toModel(allSpecs().find((s) => s.id === "glm-5.3-flash")!);
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.wokey.ai/v1");
		expect(model.provider).toBe("wokey");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
		expect(model.compat).toMatchObject({ thinkingFormat: "zai", supportsReasoningEffort: true, maxTokensField: "max_tokens" });
		// Wokey's rates, not pi's zai catalog rates.
		expect(model.cost).toMatchObject({ input: 0.075, output: 0.25 });
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
	});

	it("resolves DeepSeek Pro to the deepseek thinking format with reasoning replay", () => {
		const model = toModel(allSpecs().find((s) => s.id === "deepseek-v4-pro")!);
		expect(model.api).toBe("openai-completions");
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" });
		expect(model.compat).toMatchObject({ thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true });
		expect(model.maxTokens).toBe(384_000);
	});

	it("leaves MiniMax-M3 on pi's default thinking levels, text-only", () => {
		const model = toModel(allSpecs().find((s) => s.id === "MiniMax-M3")!);
		expect(model.api).toBe("openai-completions");
		expect(model.input).toEqual(["text"]);
		// pi's own entry carries no map — borrowed as-is, so pi's default applies.
		expect("thinkingLevelMap" in model).toBe(false);
	});

	it("registers only the selector's checked set", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "wokey-enabled-"));
		const prev = process.env.WOKEY_CONFIG;
		process.env.WOKEY_CONFIG = join(dir, "wokey.json");
		try {
			// No file yet: the verified default.
			expect([...enabledModelIds()].sort()).toEqual(["claude-opus-5-5", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
			writeFileSync(process.env.WOKEY_CONFIG, JSON.stringify({ enabledModels: ["glm-5.3-flash", "no-such-model"] }));
			expect(activeModels().map((m) => m.id)).toEqual(["glm-5.3-flash"]);
			// An emptied selection falls back to the default rather than registering nothing.
			writeFileSync(process.env.WOKEY_CONFIG, JSON.stringify({ enabledModels: [] }));
			expect(activeModels()).toHaveLength(4);
		} finally {
			if (prev === undefined) delete process.env.WOKEY_CONFIG;
			else process.env.WOKEY_CONFIG = prev;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves the opencode-routed V4.1 Flash with pi's deepseek metadata", () => {
		const model = toModel(allSpecs().find((s) => s.id === "deepseek-flash")!);
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.wokey.ai/v1");
		expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
		expect(model.compat).toMatchObject({ thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true });
		expect(model.cost).toMatchObject({ input: 0.112, output: 0.448 });
		expect(model.maxTokens).toBe(393_216);
	});
});

describe("cross-protocol model switch", () => {
	it("switches GPT→Claude API, base URL, and route policy without changing provider ID", () => {
		const gpt = toModel(activeSpecs().find((s) => s.id === "gpt-6-luna")!);
		const claude = toModel(activeSpecs().find((s) => s.id === "claude-opus-5-5")!);
		expect(gpt.provider).toBe("wokey");
		expect(claude.provider).toBe("wokey");
		expect(gpt.api).toBe("openai-responses");
		expect(claude.api).toBe("anthropic-messages");
		expect(gpt.baseUrl).toBe("https://api.wokey.ai/v1");
		expect(claude.baseUrl).toBe("https://api.wokey.ai");
		// Policy follows the model: the exact measured endpoint tuples differ.
		expect(getRoute("openai-codex").endpoint).toEqual({ host: "chatgpt.com", path: "/backend-api/codex/responses", method: "POST" });
		expect(getRoute("anthropic-direct").endpoint).toEqual({ host: "api.anthropic.com", path: "/v1/messages", method: "POST" });
	});

	it("prices Anthropic cache reads through pi's native usage/cost model", () => {
		const opus = toModel(activeSpecs().find((s) => s.id === "claude-opus-5-5")!);
		const usage = {
			input: 7,
			output: 59,
			cacheRead: 2048,
			cacheWrite: 0,
			totalTokens: 2114,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(opus as never, usage);
		// The cache-read fixture's 2048 tokens turn into dollars at 0.03/1M.
		expect(usage.cost.cacheRead).toBeCloseTo((0.03 * 2048) / 1_000_000, 12);
		expect(usage.cost.total).toBeCloseTo((0.6 * 7 + 3.0 * 59 + 0.03 * 2048) / 1_000_000, 12);
	});
});
