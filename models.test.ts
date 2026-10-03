import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GPT_MODELS, activeModels, activeSpecs, refreshFromCatalog } from "./models.ts";
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