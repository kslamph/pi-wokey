import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculateCost } from "@earendil-works/pi-ai";
import { GPT_MODELS, activeModels, activeSpecs, refreshFromCatalog, toModel } from "./models.ts";
import { DEFAULT_CONFIG } from "./config.ts";

const snapshot = () => GPT_MODELS.map((m) => ({ ...m }));

// refreshFromCatalog reconciles the baked-in table in place against the live
// catalog, so restore it after every case rather than hand-restoring inline.
let before: ReturnType<typeof snapshot>;
beforeEach(() => {
	before = snapshot();
});
afterEach(() => {
	before.forEach((s, i) => Object.assign(GPT_MODELS[i]!, s));
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

describe("cost rates", () => {
	// Regression guard. `ModelCost` rates are USD per 1M tokens — pi-ai's
	// calculateCost() does the /1e6 itself. toModel() used to pre-divide as
	// well, so every message recorded cost 1e6x too small and any cost
	// readout showed $0.00000. Pin the unit, then pin the money.
	it("declares rates in USD per 1M, the unit pi's catalog uses", () => {
		const sol = toModel(activeSpecs().find((s) => s.id === "gpt-6.1-sol")!, DEFAULT_CONFIG);
		expect(sol.cost).toEqual({ input: 0.18, output: 0.9, cacheRead: 0.009, cacheWrite: 0.225 });
	});

	it("turns a real message's usage into the right number of dollars", () => {
		const sol = toModel(activeSpecs().find((s) => s.id === "gpt-6.1-sol")!, DEFAULT_CONFIG);
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
			const model = toModel(spec, DEFAULT_CONFIG);
			expect(model.cost.input).toBe(spec.input);
			expect(model.cost.output).toBe(spec.output);
			expect(model.cost.cacheRead).toBe(spec.cacheRead);
			expect(model.cost.cacheWrite).toBe(spec.cacheWrite);
		}
	});
});

describe("config", () => {
	it("points at the API host, not the website", () => {
		expect(DEFAULT_CONFIG.baseUrl).toBe("https://api.wokey.ai/v1");
	});
});

describe("active lineup", () => {
	it("exposes only the GPT-6 generation", () => {
		expect(activeModels(DEFAULT_CONFIG).map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]);
	});

	it("matches the OpenAI model cards", () => {
		const specs = Object.fromEntries(activeSpecs().map((m: { id: string; reasoningEfforts: readonly string[] }) => [m.id, m.reasoningEfforts]));
		expect(specs["gpt-6.1-sol"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(specs["gpt-6-astra"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(specs["gpt-6-luna"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
	});
});