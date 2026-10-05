/**
 * The wokey.ai lineup, per route.
 *
 * The baked-in table below was reconciled against the live catalog
 * (`GET https://api.wokey.ai/v1/models`, 2026-10-03, 39 models): all eight GPT
 * ids exist, and the input/output/cache-read rates match
 * wokey.ai/models?vendor=chatgpt. Claude Opus 5.5 carries the approved metadata
 * from the multi-protocol design spec; its thinking map and compat flags mirror
 * pi's own generated metadata for the same model family.
 *
 * `refreshFromCatalog()` re-reads the live catalog so context limits and rates stay
 * honest — wokey documents that some models carry peak/off-peak rates on a daily
 * schedule, so a baked-in price can go stale. Failures keep the baked-in table.
 * The catalog may move numeric facts (prices, context, max output) on known ids
 * only; it can never pick a route, API, thinking map, or compatibility policy,
 * and unknown ids are never activated.
 */

import type { AnthropicMessagesCompat, Model, ModelInputLimits, ModelPromptCache, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { PROVIDER_ID, loadSettings } from "./config.ts";
import { getRoute, type WokeyApi, type WokeyRouteId } from "./routes.ts";

interface WokeyModelBase {
	id: string;
	name: string;
	/** Which route profile serves this model: its API, base URL, and policy. */
	route: WokeyRouteId;
	/** Vendor label for grouping in the `/wokey models` selector (OpenAI, Anthropic, Zhipu, …). */
	vendor: string;
	/** USD per 1M tokens. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextWindow: number;
	maxTokens: number;
	/** Excluded from every lineup surface (selector, registration, catalog
	 * warnings): price-dominated siblings and wokey-paused rows live on as
	 * reference data, and unpausing one is a single-flag change. */
	paused?: boolean;
}

export interface WokeyGptSpec extends WokeyModelBase {
	route: "openai-codex";
	/** Official OpenAI rate for the same tier, for the savings note. */
	officialInput: number;
	officialOutput: number;
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
}

export interface WokeyAnthropicSpec extends WokeyModelBase {
	route: "anthropic-direct";
	/** Input modalities callable through Wokey (the catalog is authoritative here). */
	inputModalities?: ("text" | "image")[];
	/**
	 * pi thinking-level map, borrowed from pi's own native-anthropic metadata
	 * for the same id. Absent means pi's default (all levels) — that is what
	 * pi's own entry carries for Haiku 4.5 and Sonnet 4.5, so borrowed as-is.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/**
	 * Adaptive-thinking model on the Messages API: forced adaptive thinking,
	 * mid-conversation effort/system/tool changes, strict tools, no temperature.
	 */
	compat: AnthropicMessagesCompat;
	/** Prompt cache lifetimes in seconds. */
	promptCache?: ModelPromptCache;
	inputLimits?: ModelInputLimits;
}

export interface WokeyCompletionsSpec extends WokeyModelBase {
	route: "openai-chat";
	/** Input modalities callable through Wokey (the catalog is authoritative here). */
	inputModalities?: ("text" | "image")[];
	/**
	 * pi thinking-level map, borrowed from pi's own built-in provider for the
	 * same model family (zai / opencode-go / opencode entries) — assumed correct
	 * unless live use proves otherwise. Absent means pi's default (all levels).
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** OpenAI-completions compat, borrowed the same way (thinkingFormat included). */
	compat: OpenAICompletionsCompat;
	/** Prompt cache lifetimes in seconds. */
	promptCache?: ModelPromptCache;
	inputLimits?: ModelInputLimits;
}

export type WokeyModelSpec = WokeyGptSpec | WokeyAnthropicSpec | WokeyCompletionsSpec;

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
 * Only the GPT-6 generation plus Claude Opus 5.5: the older 6-sol / 5.6-* / 5.5
 * rows are superseded and carry neither a price nor a performance advantage for
 * real use, so advertising them only invites the wrong pick. They are kept in
 * `GPT_MODELS` as verified reference data (context limits, rates and probed
 * effort support are all measured), so re-enabling one is a single edit here
 * rather than a re-probe. No other Anthropic catalog result is activated.
 */
const ACTIVE_MODEL_IDS = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-opus-5-5"] as const;

/**
 * Default registration: the verified lineup only. The Chat Completions vendors
 * (Zhipu, MiniMax, DeepSeek) are opt-in through the `/wokey models` selector —
 * their responses are unverified by design, so they stay off until chosen.
 */
const DEFAULT_ENABLED_IDS = new Set<string>(ACTIVE_MODEL_IDS);

export const GPT_MODELS: WokeyGptSpec[] = [
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", route: "openai-codex", vendor: "OpenAI", input: 0.18, output: 0.9, cacheRead: 0.009, cacheWrite: 0.225, officialInput: 2, officialOutput: 10, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-sol", paused: true, name: "GPT-6 Sol", route: "openai-codex", vendor: "OpenAI", input: 0.18, output: 0.9, cacheRead: 0.018, cacheWrite: 0.225, officialInput: 2, officialOutput: 10, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", route: "openai-codex", vendor: "OpenAI", input: 0.09, output: 0.45, cacheRead: 0.009, cacheWrite: 0.1125, officialInput: 0.1, officialOutput: 0.5, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-6-astra", name: "GPT-6 Astra", route: "openai-codex", vendor: "OpenAI", input: 0.9, output: 4.5, cacheRead: 0.09, cacheWrite: 1.125, officialInput: 10, officialOutput: 50, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const, gatewayAcceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-sol", paused: true, name: "GPT-5.6 Sol", route: "openai-codex", vendor: "OpenAI", input: 0.44, output: 2.2, cacheRead: 0.044, cacheWrite: 0.55, officialInput: 4, officialOutput: 20, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", route: "openai-codex", vendor: "OpenAI", input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, officialInput: 2, officialOutput: 12, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.6-luna", paused: true, name: "GPT-5.6 Luna", route: "openai-codex", vendor: "OpenAI", input: 0.12, output: 0.72, cacheRead: 0.012, cacheWrite: 0.15, officialInput: 0.2, officialOutput: 1.2, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const },
	{ id: "gpt-5.5", paused: true, name: "GPT-5.5", route: "openai-codex", vendor: "OpenAI", input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0, officialInput: 5, officialOutput: 30, contextWindow: 1_050_000, maxTokens: 128_000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] as const },
];

/**
 * The single active Anthropic model, served by pi's native Anthropic Messages
 * adapter through the `anthropic-direct` route. Metadata is pinned by the
 * multi-protocol design spec — the thinking map and compat flags match pi's own
 * generated metadata for the Opus 5.5 family, and the rates are wokey's.
 */
const CLAUDE_OPUS_5_5: WokeyAnthropicSpec = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	route: "anthropic-direct",
	vendor: "Anthropic",
	input: 0.6,
	output: 3.0,
	cacheRead: 0.03,
	cacheWrite: 0.75,
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	compat: {
		forceAdaptiveThinking: true,
		supportsTemperature: false,
		supportsMidConvoEffort: true,
		supportsMidConvoSystemMessages: true,
		supportsMidConvoToolChanges: true,
		supportsStrictTools: true,
	},
	promptCache: { short: 300, long: 3600 },
	inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
};

/**
 * Chat Completions vendors: Zhipu, MiniMax, DeepSeek.
 *
 * All three speak OpenAI Chat Completions through Wokey (GLM also speaks
 * Messages, but one shared route keeps this to a single adapter until live use
 * proves Messages drives GLM better — switching is a one-field `route` change).
 * Thinking maps and compat are borrowed from pi's own built-in providers for
 * the same families (zai / opencode-go / opencode) and assumed correct unless
 * live use proves otherwise; rates, context and max output are wokey's own,
 * reconciled against the live catalog like every other row.
 *
 * None of these verifies: Wokey documents proofs for Claude Messages and GPT
 * Responses on official routes only, so every exchange here reports `unproven`
 * and never warns (see routes.ts `verification: "none"`).
 */
export const COMPLETIONS_MODELS: WokeyCompletionsSpec[] = [
	{
		id: "glm-5.3", name: "GLM-5.3", route: "openai-chat", vendor: "Zhipu",
		input: 0.28, output: 0.88, cacheRead: 0.052, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 131_072,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "zai", supportsStrictMode: true, zaiToolStream: true },
	},
	{
		id: "glm-5.3-flash", name: "GLM-5.3-Flash", route: "openai-chat", vendor: "Zhipu",
		input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 131_072,
		inputModalities: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "zai", supportsStrictMode: true, zaiToolStream: true },
		inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
	},
	{
		id: "MiniMax-M3", name: "MiniMax M3", route: "openai-chat", vendor: "MiniMax",
		input: 0.09, output: 0.36, cacheRead: 0.018, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 80_000,
		inputModalities: ["text"],
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" },
	},
	{
		id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", route: "openai-chat", vendor: "DeepSeek",
		input: 0.112, output: 0.448, cacheRead: 0.00224, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 384_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
	},
	{
		id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", route: "openai-chat", vendor: "DeepSeek",
		input: 0.528, output: 1.584, cacheRead: 0.0176, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 384_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
	},
	{
		// Sourced via OpenCode Go (owned_by opencode), not the volcengine-direct
		// rows above — same family metadata from pi's deepseek entry. Baked rate
		// is the current off-peak readout; the live catalog overlay moves it.
		id: "deepseek-flash", name: "DeepSeek V4.1 Flash", route: "openai-chat", vendor: "DeepSeek",
		input: 0.112, output: 0.448, cacheRead: 0.00224, cacheWrite: 0, contextWindow: 1_000_000, maxTokens: 393_216,
		inputModalities: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
		compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
	},
];

/**
 * The full Claude lineup on the verified Messages route.
 *
 * Thinking maps and compat are borrowed from pi's own native-anthropic
 * metadata for the same ids and assumed correct unless live use proves
 * otherwise — except `claude-sonnet-5-5`, which pi ships nowhere: it mirrors
 * its sibling Sonnet 5 (flagged here so a wrong guess is easy to find).
 * Rates, context, max output and text-vs-image come from Wokey's own catalog
 * (several rows are text-only there despite pi's image-capable entries, and
 * Sonnet 4.5/Haiku carry a 200k window, not pi's 1M). `cacheWrite` is the 5m
 * rate, matching the Opus 5.5 convention. Opus 5.5 stays first: it is the
 * measured, live-verified reference row.
 */
export const CLAUDE_MODELS: WokeyAnthropicSpec[] = [
	CLAUDE_OPUS_5_5,
	{
		id: "claude-opus-5", paused: true, name: "Claude Opus 5", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-8", paused: true, name: "Claude Opus 4.8", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-7", paused: true, name: "Claude Opus 4.7", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-6", paused: true, name: "Claude Opus 4.6", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.9375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		// No pi entry anywhere for this id: mirrors Sonnet 5 until proven otherwise.
		id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0.375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-5", paused: true, name: "Claude Sonnet 5", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0.375, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-4-6", paused: true, name: "Claude Sonnet 4.6", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.45, output: 2.25, cacheRead: 0.045, cacheWrite: 0.5625, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-4-5", paused: true, name: "Claude Sonnet 4.5", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.45, output: 2.25, cacheRead: 0.045, cacheWrite: 0.5625, contextWindow: 200_000, maxTokens: 64_000,
		inputModalities: ["text"],
		compat: { supportsStrictTools: true },
	},
	{
		id: "claude-haiku-4-5", paused: true, name: "Claude Haiku 4.5", route: "anthropic-direct", vendor: "Anthropic",
		input: 0.2, output: 1.0, cacheRead: 0.02, cacheWrite: 0.25, contextWindow: 200_000, maxTokens: 64_000,
		inputModalities: ["text"],
		compat: { supportsStrictTools: true },
	},
	{
		id: "claude-fable-5-1", name: "Claude Fable 5.1", route: "anthropic-direct", vendor: "Anthropic",
		input: 2.39, output: 11.95, cacheRead: 0.05975, cacheWrite: 2.9875, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text", "image"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-fable-5", paused: true, name: "Claude Fable 5", route: "anthropic-direct", vendor: "Anthropic",
		input: 2.39, output: 11.95, cacheRead: 0.239, cacheWrite: 2.9875, contextWindow: 1_000_000, maxTokens: 128_000,
		inputModalities: ["text"],
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" },
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, forceAdaptiveThinking: true, supportsStrictTools: true },
	},
];

/** The provider-wide catalog: every known row, regardless of route. */
export const WOKEY_MODELS: WokeyModelSpec[] = [...GPT_MODELS, ...CLAUDE_MODELS, ...COMPLETIONS_MODELS];

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

export function toModel(spec: WokeyGptSpec): Model<"openai-responses">;
export function toModel(spec: WokeyAnthropicSpec): Model<"anthropic-messages">;
export function toModel(spec: WokeyCompletionsSpec): Model<"openai-completions">;
export function toModel(spec: WokeyModelSpec): Model<WokeyApi>;
export function toModel(spec: WokeyModelSpec): Model<WokeyApi> {
	// API and base URL come from the route profile, never from global config or
	// the live catalog — a model cannot change which adapter serves it.
	const route = getRoute(spec.route);
	const shared = {
		id: spec.id,
		name: spec.name,
		provider: PROVIDER_ID,
		baseUrl: route.baseUrl,
		input: ["text", "image"] as ("text" | "image")[],
		// `ModelCost` rates are USD per 1M tokens — the same unit as `spec`, and
		// the unit pi's own catalog uses (models-store.json: openai gpt-6.1-sol is
		// {"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2.5}). pi-ai's
		// calculateCost() divides by 1e6 itself when it turns these into dollars
		// (pi-ai/dist/models.js), so they must NOT be pre-divided here — doing so
		// made every recorded message cost 1e6x too small, and a cost readout
		// rendered as $0.00000. The `/wokey models` price table is unaffected
		// either way: it prints `spec` rates, not this block.
		cost: {
			input: spec.input,
			output: spec.output,
			cacheRead: spec.cacheRead,
			cacheWrite: spec.cacheWrite,
		},
		reasoning: true,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	};
	if (route.api === "anthropic-messages") {
		if (spec.route !== "anthropic-direct") throw new Error(`wokey: spec "${spec.id}" routes to "${spec.route}" but the profile serves "${route.api}"`);
		return {
			...shared,
			api: route.api,
			input: spec.inputModalities ?? ["text", "image"],
			// Absent map means pi's default (all levels) — that is what pi's own
			// entry for this family carries, so it is borrowed as-is.
			...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
			compat: { ...spec.compat },
			...(spec.promptCache ? { promptCache: { ...spec.promptCache } } : {}),
			...(spec.inputLimits ? { inputLimits: { ...spec.inputLimits, images: spec.inputLimits.images ? { ...spec.inputLimits.images } : undefined } } : {}),
		};
	}
	if (route.api === "openai-completions") {
		if (spec.route !== "openai-chat") throw new Error(`wokey: spec "${spec.id}" routes to "${spec.route}" but the profile serves "${route.api}"`);
		return {
			...shared,
			api: route.api,
			input: spec.inputModalities ?? ["text", "image"],
			// Absent map means pi's default (all levels) — that is what pi's own
			// entry for this family carries, so it is borrowed as-is.
			...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
			compat: { ...spec.compat },
			...(spec.promptCache ? { promptCache: { ...spec.promptCache } } : {}),
			...(spec.inputLimits ? { inputLimits: { ...spec.inputLimits, images: spec.inputLimits.images ? { ...spec.inputLimits.images } : undefined } } : {}),
		};
	}
	if (spec.route !== "openai-codex") throw new Error(`wokey: spec "${spec.id}" routes to "${spec.route}" but the profile serves "${route.api}"`);
	return {
		...shared,
		api: route.api,
		thinkingLevelMap: thinkingLevelMapFor(spec.reasoningEfforts),
	};
}

const ACTIVE = new Set<string>(ACTIVE_MODEL_IDS);

/**
 * Ids the selector registered. `undefined` in settings means "never chosen",
 * which falls back to the verified default — the unverified vendors stay off
 * until explicitly picked. Unknown ids are dropped, so a stale file cannot
 * resurrect a retired model.
 */
export function enabledModelIds(): Set<string> {
	const known = new Set(WOKEY_MODELS.filter((m) => !m.paused).map((m) => m.id));
	const saved = loadSettings().enabledModels;
	if (!saved) return new Set(DEFAULT_ENABLED_IDS);
	const picked = saved.filter((id) => known.has(id));
	return new Set(picked.length > 0 ? picked : DEFAULT_ENABLED_IDS);
}

export function activeModels(): Model<WokeyApi>[] {
	const enabled = enabledModelIds();
	return WOKEY_MODELS.filter((m) => !m.paused && enabled.has(m.id)).map((m) => toModel(m));
}

export function activeSpecs(): WokeyModelSpec[] {
	const enabled = enabledModelIds();
	return WOKEY_MODELS.filter((m) => !m.paused && enabled.has(m.id));
}

/** Every known row for the selector, verified lineup first. */
export function allSpecs(): WokeyModelSpec[] {
	return WOKEY_MODELS.filter((m) => !m.paused);
}

// ── live catalog ───────────────────────────────────────────────────────────────

interface CatalogEntry {
	id: string;
	name?: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string; input_cache_write_1h?: string };
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
 * Only numeric facts move: the entry carries no route, API, thinking map, or
 * compat of its own, and none is read even if one is present.
 */
export function refreshFromCatalog(data: unknown): { updated: string[]; warnings: string[] } {
	const entries = (data as { data?: CatalogEntry[] })?.data;
	if (!Array.isArray(entries)) return { updated: [], warnings: ["catalog: no data array"] };

	const byId = new Map(entries.filter((e) => typeof e?.id === "string").map((e) => [e.id, e]));
	const updated: string[] = [];
	const warnings: string[] = [];

	for (const spec of WOKEY_MODELS) {
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
		// Wokey's 1-hour cache-write rate is validated against Anthropic's native
		// `2 × input` rule and never stored: pi's calculateCost() prices 1h writes
		// natively (`usage.cacheWrite1h` at 2× input on top of base `cacheWrite`),
		// so adopting the figure would double-count it. A divergent quote is a
		// display/cost-model question, surfaced as a warning.
		if (spec.route === "anthropic-direct" && p.input_cache_write_1h !== undefined) {
			const quoted = rate(p.input_cache_write_1h);
			if (quoted > 0) {
				const expected = 2 * spec.input;
				if (Math.abs(quoted - expected) > 1e-9) {
					warnings.push(
						`catalog: ${spec.id} input_cache_write_1h ${quoted} diverges from native 2×input ${expected} — keeping native calculation`,
					);
				}
			}
		}
		// Only report rows that actually moved, so a no-op sync does not churn the
		// provider registration on every startup.
		if (changed) updated.push(spec.id);
	}
	return { updated, warnings };
}

/**
 * Current numeric facts for one model id: the rates pi prices with plus the
 * window facts. Read live (after `refreshFromCatalog` moved them), never cached.
 */
export interface LivePricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	contextWindow: number;
	maxTokens: number;
}

/**
 * The catalog-owned facts for one model id, or `undefined` for an id this
 * provider does not know (e.g. a `models.json` custom entry reusing the wokey
 * provider id). The stream wrapper prices every call through this, so a
 * session that keeps a pre-refresh model object still records the current
 * peak/off-peak rate instead of a stale one.
 */
export function livePricingFor(id: string): LivePricing | undefined {
	const spec = WOKEY_MODELS.find((m) => m.id === id);
	if (!spec) return undefined;
	return {
		input: spec.input,
		output: spec.output,
		cacheRead: spec.cacheRead,
		cacheWrite: spec.cacheWrite,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
	};
}
