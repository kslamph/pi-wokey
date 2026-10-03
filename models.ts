/**
 * The wokey.ai GPT lineup.
 *
 * The baked-in table below was reconciled against the live catalog
 * (`GET https://api.wokey.ai/v1/models`, 2026-10-03, 39 models): all eight ids
 * exist, and the input/output/cache-read rates match wokey.ai/models?vendor=chatgpt.
 *
 * `refreshFromCatalog()` re-reads the live catalog so context limits and rates stay
 * honest — wokey documents that some models carry peak/off-peak rates on a daily
 * schedule, so a baked-in price can go stale. Failures keep the baked-in table.
 */

import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { PROVIDER_ID, type WokeyConfig } from "./config.ts";

export interface WokeyModelSpec {
	id: string;
	name: string;
	/** USD per 1M tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Official OpenAI rate for the same tier, for the savings note. */
	officialInput: number;
	officialOutput: number;
	contextWindow: number;
	maxTokens: number;
	/**
	 * `reasoning.effort` values the model supports, per OpenAI's model card. This is
	 * the source of truth for the thinking picker.
	 *
	 * Source: developers.openai.com/api/docs/models/<id>
	 *   gpt-6.1-sol — "supports low, medium (default), high, xhigh, and max.
	 *                  The none and minimal reasoning efforts are not supported."
	 *   gpt-6-luna  — "supports none, low, medium (default), high, xhigh, and max."
	 *   gpt-6-astra — "supports low, medium, high, xhigh, and max."
	 */
	reasoningEfforts: readonly string[];
	/**
	 * What the wokey gateway *accepted* on 2026-10-03, kept only as evidence and NOT
	 * used for the picker.
	 *
	 * Do not derive the picker from this. The gateway accepts some values the model
	 * card rules out — gpt-6.1-sol and gpt-6-astra both returned 200 for `none`, and
	 * gpt-6-astra also for `minimal` — because it rewrites a known-but-unsupported
	 * effort to a neighbouring supported one and only hard-rejects values it cannot
	 * place at all (a nonsense value like `banana` is refused outright). Probing the
	 * gateway therefore measures wokey's leniency, not OpenAI's support, and would put
	 * a broken option in the picker.
	 */
	gatewayAcceptedEfforts?: readonly string[];
	/** wokey marks some rows "(paused)"; kept out of the default lineup. */
	paused?: boolean;
}

/*
 * NOTE on the retired rows below (gpt-6-sol, gpt-5.6-*, gpt-5.5): their
 * `reasoningEfforts` came from probing the wokey gateway, not from an OpenAI model
 * card, and are therefore *not* authoritative — see `gatewayAcceptedEfforts` on the
 * active rows for why the gateway over-reports. They are reference data only; check
 * the model card before re-enabling one.
 */

/**
 * The models this provider exposes.
 *
 * Only the GPT-6 generation: the older 6-sol / 5.6-* / 5.5 rows are superseded and
 * carry neither a price nor a performance advantage for real use, so advertising them
 * only invites the wrong pick. They are kept in `GPT_MODELS` as verified reference data
 * (context limits, rates and probed effort support are all measured), so re-enabling one
 * is a single edit here rather than a re-probe.
 */
const ACTIVE_MODEL_IDS = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"] as const;

export const GPT_MODELS: WokeyModelSpec[] = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: 0.18, output: 0.9, cacheRead: 0.009, cacheWrite: 0.225, officialInput: 2, officialOutput: 10, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-sol", name: "GPT-6 Sol", input: 0.18, output: 0.9, cacheRead: 0.018, cacheWrite: 0.225, officialInput: 2, officialOutput: 10, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", input: 0.09, output: 0.45, cacheRead: 0.009, cacheWrite: 0.1125, officialInput: 0.1, officialOutput: 0.5, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-astra", name: "GPT-6 Astra", input: 0.9, output: 4.5, cacheRead: 0.09, cacheWrite: 1.125, officialInput: 10, officialOutput: 50, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", input: 0.44, output: 2.2, cacheRead: 0.044, cacheWrite: 0.55, officialInput: 4, officialOutput: 20, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, officialInput: 2, officialOutput: 12, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", input: 0.12, output: 0.72, cacheRead: 0.012, cacheWrite: 0.15, officialInput: 0.2, officialOutput: 1.2, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.5", name: "GPT-5.5", input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0, officialInput: 5, officialOutput: 30, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] as const },
];

const PER_MILLION = 1_000_000;

/**
 * pi thinking level -> OpenAI `reasoning.effort`.
 *
 * The two vocabularies line up 1:1, which is what makes this a table rather than
 * guesswork:
 *
 *   pi:   off  minimal  low  medium  high  xhigh  max
 *   OAI:  none minimal  low  medium  high  xhigh  max
 *
 * The value is passed straight through to `reasoning.effort`, so any effort string a
 * vendor invents can be reached by mapping a pi level onto it — there is no reserved
 * "special" sentinel; the string *is* the extension point.
 *
 * `null` means "this model does not support it", which pi's `getSupportedThinkingLevels`
 * treats as hidden from the picker (`models.js:684-691`). `xhigh` and `max` are opt-in in
 * pi — they appear only when explicitly present in the map — so omitting them hides them
 * and defining them exposes them. `clampThinkingLevel` then steps a too-high request down
 * to the nearest level the model does support.
 */
const PI_TO_EFFORT = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

export function thinkingLevelMapFor(supported: readonly string[]): ThinkingLevelMap {
	const set = new Set(supported);
	const map: Record<string, string | null> = {};
	for (const [level, effort] of Object.entries(PI_TO_EFFORT)) {
		map[level] = set.has(effort) ? effort : null;
	}
	return map as ThinkingLevelMap;
}

export function toModel(spec: WokeyModelSpec, config: WokeyConfig): Model<"openai-codex-responses" | "openai-responses" | "openai-completions"> {
	return {
		id: spec.id,
		name: spec.name,
		api: config.api,
		provider: PROVIDER_ID,
		baseUrl: config.baseUrl,
		input: ["text", "image"],
		cost: {
			input: spec.input / PER_MILLION,
			output: spec.output / PER_MILLION,
			cacheRead: spec.cacheRead / PER_MILLION,
			cacheWrite: spec.cacheWrite / PER_MILLION,
		},
		reasoning: true,
		thinkingLevelMap: thinkingLevelMapFor(spec.reasoningEfforts),
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		promptCache: { retention: "in-memory" },
	} as Model<"openai-codex-responses" | "openai-responses" | "openai-completions">;
}

const ACTIVE = new Set<string>(ACTIVE_MODEL_IDS);

export function activeModels(config: WokeyConfig): Model<"openai-codex-responses" | "openai-responses" | "openai-completions">[] {
	return GPT_MODELS.filter((m) => !m.paused && ACTIVE.has(m.id)).map((m) => toModel(m, config));
}

export function activeSpecs(): WokeyModelSpec[] {
	return GPT_MODELS.filter((m) => !m.paused && ACTIVE.has(m.id));
}

// ── live catalog ───────────────────────────────────────────────────────────────

interface CatalogEntry {
	id: string;
	name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

/**
 * Per-token price -> USD per 1M, without float dust.
 *
 * The catalog quotes decimal strings ("0.0000009"), so scaling by 1e6 lands on
 * 0.8999999999999999. Round to 6 decimal places after scaling — six decimals is
 * exactly the precision of a per-1M price, so this cannot alter a real rate.
 */
const rate = (v: string | undefined): number => {
	const n = Number.parseFloat(v ?? "");
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * PER_MILLION * 1e6) / 1e6;
};

/**
 * Reconcile the baked-in table with the live catalog in place. Unknown ids are
 * ignored and the baked-in values are kept on any malformed field, so a partial
 * or hostile catalog response cannot shrink a context window or zero a rate.
 */
export function refreshFromCatalog(data: unknown): { updated: string[]; warnings: string[] } {
	const entries = (data as { data?: CatalogEntry[] })?.data;
	if (!Array.isArray(entries)) return { updated: [], warnings: ["catalog: no data array"] };

	const byId = new Map(entries.filter((e) => typeof e?.id === "string").map((e) => [e.id, e]));
	const updated: string[] = [];
	const warnings: string[] = [];

	for (const spec of GPT_MODELS) {
		const live = byId.get(spec.id);
		if (!live) {
			// Only active rows are advertised; a retired row vanishing upstream is
			// reference-data drift, not a startup warning the user needs to see.
			if (ACTIVE.has(spec.id)) warnings.push(`catalog: ${spec.id} not listed upstream — keeping baked-in values`);
			continue;
		}
		let changed = false;
		// Never let a missing field shrink what we already believe.
		if (typeof live.context_length === "number" && live.context_length > spec.contextWindow) {
			spec.contextWindow = live.context_length;
			changed = true;
		}
		if (typeof live.max_completion_tokens === "number" && live.max_completion_tokens > 0 && live.max_completion_tokens !== spec.maxTokens) {
			spec.maxTokens = live.max_completion_tokens;
			changed = true;
		}
		const p = live.pricing ?? {};
		for (const [key, field] of [
			["prompt", "input"],
			["completion", "output"],
			["input_cache_read", "cacheRead"],
			["input_cache_write", "cacheWrite"],
		] as const) {
			const value = rate(p[key]);
			if (value > 0 && value !== spec[field]) {
				spec[field] = value;
				changed = true;
			}
		}
		// Only report rows that actually moved, so a no-op sync does not churn the
		// provider registration on every startup.
		if (changed) updated.push(spec.id);
	}
	return { updated, warnings };
}