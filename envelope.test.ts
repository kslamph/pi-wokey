import { describe, expect, it } from "vitest";
import { applyCodexEnvelope } from "./stream.ts";
import { thinkingLevelMapFor, GPT_MODELS } from "./models.ts";
import { resolveConfig } from "./config.ts";
import { getRoute } from "./routes.ts";

const base = { model: "gpt-6-luna", input: [{ role: "user", content: "hi" }], stream: true, store: false };

describe("codex envelope", () => {
	it("fills the fields the chatgpt.com codex backend expects", () => {
		const out = applyCodexEnvelope({ ...base }, "ck");
		expect(out.store).toBe(false);
		expect(out.instructions).toBe("You are a helpful assistant.");
		expect(out.text).toEqual({ verbosity: "low" });
		expect(out.include).toEqual(["reasoning.encrypted_content"]);
		expect(out.prompt_cache_key).toBe("ck");
		expect(out.tool_choice).toBe("auto");
		expect(out.parallel_tool_calls).toBe(true);
	});

	it("forces store:false even if a caller set it true (codex rejects store:true)", () => {
		expect(applyCodexEnvelope({ ...base, store: true }, "ck").store).toBe(false);
	});

	// The whole point of thinking levels must survive envelope shaping.
	it("never overwrites the reasoning the user asked for", () => {
		const out = applyCodexEnvelope({ ...base, reasoning: { effort: "high", summary: "auto" } }, "ck");
		expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	it("does not clobber caller-supplied values it is only meant to default", () => {
		const out = applyCodexEnvelope({ ...base, instructions: "custom", text: { verbosity: "high" }, tool_choice: "none" }, "ck");
		expect(out.instructions).toBe("custom");
		expect(out.text).toEqual({ verbosity: "high" });
		expect(out.tool_choice).toBe("none");
	});

	it("does not mutate the caller's payload", () => {
		const input = { ...base };
		applyCodexEnvelope(input, "ck");
		expect(input).toEqual(base);
	});

	it("tolerates junk", () => {
		expect(applyCodexEnvelope(null, "ck")).toEqual({});
		expect(applyCodexEnvelope("nope", "ck")).toEqual({});
		expect(applyCodexEnvelope([1, 2], "ck")).toEqual({});
	});
});

describe("thinking level map", () => {
	const ALL = ["none","minimal","low","medium","high","xhigh","max"];

	it("maps pi off to OpenAI's 'none'", () => {
		expect(thinkingLevelMapFor(ALL).off).toBe("none");
	});

	it("maps 1:1 across the whole shared vocabulary", () => {
		expect(thinkingLevelMapFor(ALL)).toEqual({
			off: "none", minimal: "minimal", low: "low",
			medium: "medium", high: "high", xhigh: "xhigh", max: "max",
		});
	});

	// Regression guard for the bug this replaced: probing the gateway reported
	// none/minimal as supported for 6.1-sol and astra; the model cards rule them out.
	it("does not inherit levels the gateway accepts but the model card forbids", () => {
		const astra = GPT_MODELS.find((m) => m.id === "gpt-6-astra")!;
		expect(astra.gatewayAcceptedEfforts).toContain("minimal");
		expect(astra.reasoningEfforts).not.toContain("minimal");
		expect(astra.reasoningEfforts).not.toContain("none");
	});

	it("hides a level the model rejects with null", () => {
		expect(thinkingLevelMapFor(ALL.filter((v) => v !== "minimal")).minimal).toBeNull();
	});

	// The behaviour that actually matters in the picker, per models.js:681-692.
	it("exposes exactly the supported levels to pi's picker", async () => {
		const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
		const pick = (id: string) => {
			const spec = GPT_MODELS.find((m) => m.id === id)!;
			return getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: thinkingLevelMapFor(spec.reasoningEfforts) } as never);
		};
		// Per OpenAI's model cards, not per gateway leniency.
		expect(pick("gpt-6.1-sol")).toEqual(["low","medium","high","xhigh","max"]);      // no none, no minimal
		expect(pick("gpt-6-astra")).toEqual(["low","medium","high","xhigh","max"]);      // no none, no minimal
		expect(pick("gpt-6-luna")).toEqual(["off","low","medium","high","xhigh","max"]); // has none, no minimal
	});
});

describe("config", () => {
	it("uses a bearer-key adapter, not the ChatGPT-OAuth codex adapter", () => {
		expect(getRoute("openai-codex").api).toBe("openai-responses");
	});

	it("applies the Codex envelope through the GPT route policy", () => {
		const out = getRoute("openai-codex").transformPayload({ model: "gpt-6-luna" }, "ck");
		expect(out.store).toBe(false);
		expect(out.prompt_cache_key).toBe("ck");
	});
});

describe("/wokey renderer", () => {
	it("shows a live status panel with the balance, and no static detail", async () => {
		const { renderStatus } = await import("./tui.ts");
		const text = renderStatus(resolveConfig(), undefined, {
			balance: { availableUsd: 10.787384, reservedUsd: 0 },
		});
		expect(text).toContain("$10.79"); // live balance, cents always shown
		expect(text).toContain("no exchange yet this session");
		// Trust anchors, settings paths and the accepted-limit prose are static:
		// documentation belongs in the README, not in a panel opened every turn.
		expect(text).not.toContain("437cbab8c2e5dd11");
		expect(text).not.toContain("pinned");
		expect(text).not.toContain("settings");
	});

	it("lists the active lineup with prices and per-model thinking levels", async () => {
		const { renderModels } = await import("./tui.ts");
		const text = renderModels();
		for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) expect(text).toContain(id);
		expect(text).toContain("$0.18");          // gpt-6.1-sol / gpt-6-sol input rate
		expect(text).toContain("$0.09");          // gpt-6-luna input rate
		expect(text).toContain("$4.5");           // gpt-6-astra output rate
		expect(text).not.toMatch(/\$0\.(?!\d)/); // a per-token rescale printed a bare "$0."
		expect(text).not.toContain("$$");
		expect(text).not.toContain("gpt-5.5");       // retired rows are not advertised
		expect(text).not.toContain("gpt-5.6-terra");
		// luna has no minimal per its model card; 6.1-sol does not either.
		const luna = text.split("\n").find((l) => l.startsWith("gpt-6-luna"))!;
		const sol = text.split("\n").find((l) => l.startsWith("gpt-6.1-sol"))!;
		expect(luna).toContain("off");
		expect(sol).not.toContain("minimal");
	});
});
