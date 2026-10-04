/**
 * /wokey — the whole management UI behind one command.
 *
 * `/wokey` opens a menu, so nothing has to be memorised. The subcommands
 * (`status`, `models`) stay available for scripting and for headless `pi -p`,
 * where there is no UI to draw a menu in. Credentials are pi-managed
 * (`/login wokey`, `WOKEY_API_KEY`) — this extension never touches them, so
 * the old `/wokey key` / `/wokey unset` verbs only point at pi auth now.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { hasLegacyApiKey, settingsPath, type WokeyConfig } from "./config.ts";
import { activeSpecs, toModel } from "./models.ts";
import { getRoute, ROUTES } from "./routes.ts";
import type { BalanceInfo } from "./balance.ts";
import type { ProofReport } from "./verify/probe.ts";

export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export interface MenuStats {
	verified: number;
	gapped: number;
	failed: number;
	unproven: number;
}

export const MARK = {
	verified: "✅",
	"verified-with-gaps": "🟡",
	failed: "❌",
	unproven: "⚠️",
} as const;

export interface MenuDeps {
	config(): WokeyConfig;
	stats(): MenuStats;
	last(): ProofReport | undefined;
	/** Last catalog-overlay warnings, kept by the provider (see provider.ts). */
	warnings(): string[];
	/** Re-sync the catalog through pi's model registry; bound to `r` in the Status panel. */
	refresh(): Promise<void>;
	/** Last known account balance, or `undefined` if it was never read. Re-read on every render. */
	balance(): BalanceInfo | undefined;
	/** Read the balance from the relay; runs when the panel opens and on `r`. Never rejects. */
	syncBalance(): Promise<void>;
}

export interface StatusOptions {
	/** Account balance to show. `undefined` renders a dash, never a blank. */
	balance?: BalanceInfo;
	/** Reveal the trust anchors (pinned / upstream / probing / settings). */
	expanded?: boolean;
	/** Last catalog-overlay warnings; rendered as their own section. */
	warnings?: string[];
	/**
	 * A leftover `apiKey` in an old `wokey.json` was detected. Set by the
	 * status entry point (one `hasLegacyApiKey()` read per panel open);
	 * defaults to false so the renderer stays pure. Pass explicitly in tests.
	 */
	legacyKey?: boolean;
}

// ── renderers (pure, so they are trivially testable and reuseable headlessly) ──

/** USD for a money amount: always cents. A balance of exactly $5 reads "$5.00",
 * not "$5" — trimming zeros is for the Models rate table, not for what you owe. */
const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The always-visible half of the status view: counters, what you can spend, which
 * key is in use, and the last exchange with its individual checks. The trust
 * anchors live behind `m` — they are the reassuring part, and the first thing
 * anyone should read on *failure*, so they fold away only when `expanded` is set.
 */
export function renderStatus(
	config: WokeyConfig,
	stats: MenuStats,
	last: ProofReport | undefined,
	opts: StatusOptions = {},
): string {
	const legacyKey = opts.legacyKey ?? false;
	const warnings = opts.warnings ?? [];
	const balance = opts.balance
		? `${usd(opts.balance.availableUsd)} available${opts.balance.reservedUsd > 0 ? ` · ${usd(opts.balance.reservedUsd)} reserved` : ""}`
		: "—";
	const lines = [
		`wokey.ai · ${MARK.verified} ${stats.verified}   ${MARK["verified-with-gaps"]} ${stats.gapped}   ${MARK.failed} ${stats.failed}   ${MARK.unproven} ${stats.unproven}`,
		"",
		`balance   ${balance}`,
		`auth      pi-managed — /login wokey or WOKEY_API_KEY`,
	];
	if (legacyKey) {
		lines.push(
			`          [!] a legacy key is still stored in ${settingsPath()} — re-enter it with /login wokey, then delete the apiKey entry`,
		);
	}
	if (opts.expanded) {
		lines.push(
			`pinned    ${config.expectedPcr0 ? `${config.expectedPcr0.slice(0, 24)}…` : "(unset — model substitution NOT checked)"}`,
			...Object.values(ROUTES).map(
				(route) => `upstream  ${route.endpoint.host}${route.endpoint.path} ${route.endpoint.method} (route ${route.id})`,
			),
			`probing   ${config.verify ? "on (warn-only)" : "off"} · routes openai-codex (openai-responses) + anthropic-direct (anthropic-messages)`,
			`settings  ${settingsPath()}`,
		);
	}
	if (!last) {
		lines.push("", "No response verified yet this session.");
	} else {
		lines.push(
			"",
			`last      ${MARK[last.status]} ${last.upstreamHost ?? "—"}${last.upstreamPath ?? ""}${last.upstreamMethod ? ` ${last.upstreamMethod}` : ""}`,
			`          model ${last.reportedModel ?? "?"} · ${last.bytes} B · ${last.durationMs} ms`,
		);
		for (const c of last.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
	}
	if (warnings.length > 0) {
		lines.push("", "catalog warnings:");
		for (const w of warnings) lines.push(`  ! ${w}`);
	}
	return lines.join("\n");
}

export function renderModels(): string {
	// Rates are USD per 1M; format explicitly so the table aligns and never shows
	// float dust like 0.8999999999999999.
	const money = (n: number): string => `$${n.toFixed(2).replace(/\.?0+$/, "") || "0"}`;
	const rows = activeSpecs().map((s) => {
		// Build the map the same way toModel does, so the listed levels are exactly
		// what pi's picker will offer for this model.
		const levels = getSupportedThinkingLevels(toModel(s) as never) as string[];
		return {
			id: s.id,
			// Model family follows the route: GPT rows go through the
			// OpenAI-compatible relay root, Claude through Anthropic Messages.
			family: s.route === "anthropic-direct" ? "Claude" : "GPT",
			api: getRoute(s.route).api,
			// spec rates are already USD per 1M tokens — do not scale again.
			in: money(s.input),
			out: money(s.output),
			ctx: s.contextWindow >= 1_000_000 ? `${(s.contextWindow / 1_000_000).toFixed(2)}M` : `${Math.round(s.contextWindow / 1000)}k`,
			levels: levels.join(" "),
		};
	});
	const out = [
		`${"model".padEnd(15)}  ${"family".padEnd(6)}  ${"api".padEnd(18)}  ${"in/1M".padEnd(7)}  ${"out/1M".padEnd(8)}  ${"ctx".padEnd(6)}thinking levels`,
		"-".repeat(104),
	];
	for (const r of rows) {
		out.push(
			`${r.id.padEnd(15)}  ${r.family.padEnd(6)}  ${r.api.padEnd(18)}  ${r.in.padEnd(7)}  ${r.out.padEnd(8)}  ${r.ctx.padEnd(6)}${r.levels}`,
		);
	}
	out.push("", `Select one with /model, e.g.  /model wokey/gpt-6-luna:high`);
	out.push("Rates are re-read from GET /v1/models on every startup (wokey uses dynamic_discount).");
	return out.join("\n");
}

// ── in-TUI panels (ctx.ui.custom, same visual language as pi-free-provider) ────

/** Compact single-select rendered inside the TUI. */
function selectOne(ctx: CommandContext, title: string, items: { value: string; label: string }[]): Promise<string | null> {
	if (items.length === 0) return Promise.resolve(null);
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				items.forEach((item, i) => {
					const pointer = i === cursor ? theme.fg("accent", "❯ ") : "  ";
					add(` ${pointer}${item.label}`);
				});
				add();
				add(` ${theme.fg("text", "↑/↓ move · enter select · esc cancel")}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
				else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
				else if (matchesKey(data, Key.return)) done(items[cursor]?.value ?? null);
				else if (matchesKey(data, Key.escape)) done(null);
				tui.requestRender();
			},
		};
	});
}

/**
 * Read-only info panel. `getBody` is re-evaluated on every render, so the panel
 * shows fresh state once an action has run.
 *
 * `onRefresh` and `onMore` are independent: one toggles a fold inside the body,
 * the other reloads state from the relay. Either may be omitted, and the footer
 * only advertises the keys that exist.
 */
function infoPanel(
	ctx: CommandContext,
	title: string,
	getBody: (expanded: boolean) => string,
	actions?: { onRefresh?: () => Promise<void>; onMore?: () => void },
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let refreshing = false;
		let expanded = false;
		const footer = (): string => {
			const keys = ["enter/esc close"];
			if (actions?.onRefresh) keys.push("r refresh");
			if (actions?.onMore) keys.push(expanded ? "m less" : "m more");
			return keys.join(" · ");
		};
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of getBody(expanded).split("\n")) add(` ${line}`);
				add();
				if (refreshing) add(` ${theme.fg("text", "refreshing…")}`);
				else add(` ${theme.fg("text", footer())}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.return) || matchesKey(data, Key.escape)) {
					done();
					return;
				}
				if (actions?.onMore && (data === "m" || data === "M")) {
					expanded = !expanded;
					tui.requestRender();
					return;
				}
				if (actions?.onRefresh && (data === "r" || data === "R") && !refreshing) {
					refreshing = true;
					tui.requestRender();
					// Whatever `onRefresh` covers (catalog, balance, both) reloads
					// under one "refreshing…" state, so `r` never leaves a
					// half-stale view behind.
					void actions
						.onRefresh()
						.catch(() => undefined)
						.finally(() => {
							refreshing = false;
							tui.requestRender();
						});
					return;
				}
				tui.requestRender();
			},
		};
	});
}

/**
 * The status panel folds its trust anchors behind `m`, so the body is a thunk
 * over the fold state rather than pre-rendered text. Opening the panel kicks off
 * a balance read: the number lands on the next render, and a slow relay costs a
 * moment rather than a blank panel.
 */
function openStatus(ctx: CommandContext, deps: MenuDeps): Promise<void> {
	void deps.syncBalance();
	// One disk read per panel open, not per render: renderStatus is pure and
	// the fold toggle re-renders without touching disk.
	const legacyKey = hasLegacyApiKey();
	return infoPanel(
		ctx,
		"wokey.ai · status",
		(expanded) =>
			renderStatus(deps.config(), deps.stats(), deps.last(), {
				balance: deps.balance(),
				expanded,
				warnings: deps.warnings(),
				legacyKey,
			}),
		{
			// Catalog and balance reload together, so `r` cannot leave the price
			// list fresh next to a stale balance.
			onRefresh: async () => {
				await Promise.all([deps.refresh(), deps.syncBalance()]);
			},
			onMore: () => undefined, // presence is what binds `m`; state lives above
		},
	);
}

function openModels(ctx: CommandContext): Promise<void> {
	return infoPanel(ctx, "wokey.ai · models", () => renderModels());
}

// ── entry point ───────────────────────────────────────────────────────────────

const USAGE = "usage: /wokey  ·  /wokey status  ·  /wokey models   (credentials via /login wokey, /logout wokey)";

const MENU = [
	{ value: "status", label: "Status — verification counters, auth, trust anchors" },
	{ value: "models", label: "Models — lineup, prices, thinking levels" },
] as const;

/**
 * The retired duplicate key store: credentials are pi-managed, so these verbs
 * only point at pi auth. They stay (instead of falling through to USAGE) so a
 * user typing the old command learns where the key went.
 */
function keyGuidance(verb: string): string {
	return verb === "key"
		? "wokey: API keys are managed by pi — run /login wokey (or set WOKEY_API_KEY). The old /wokey key store is retired."
		: "wokey: API keys are managed by pi — run /logout wokey to remove the key. The old /wokey unset store is retired.";
}

export async function runMenu(deps: MenuDeps, args: string[], ctx: CommandContext): Promise<void> {
	const verb = (args[0] ?? "").toLowerCase();

	const show = (text: string): void => {
		ctx.ui.notify(text, "info");
		if (!ctx.hasUI) process.stderr.write(`${text}\n`);
	};

	/** Headless status: no panel to refresh, so read the balance once and print. */
	const showStatusHeadless = async (): Promise<void> => {
		await deps.syncBalance();
		show(
			renderStatus(deps.config(), deps.stats(), deps.last(), {
				balance: deps.balance(),
				warnings: deps.warnings(),
				legacyKey: hasLegacyApiKey(),
			}),
		);
	};

	// Subcommands stay available for scripting and headless runs; with a UI the
	// info views open as in-TUI panels instead of toasts.
	if (verb === "status") {
		if (ctx.hasUI) await openStatus(ctx, deps);
		else await showStatusHeadless();
		return;
	}
	if (verb === "models" || verb === "model" || verb === "list") {
		if (ctx.hasUI) await openModels(ctx);
		else show(renderModels());
		return;
	}
	if (verb === "key" || verb === "unset" || verb === "clear") {
		show(keyGuidance(verb));
		return;
	}
	if (verb === "help" || verb === "?") {
		show(USAGE);
		return;
	}
	if (verb) {
		show(USAGE);
		return;
	}
	if (!ctx.hasUI) {
		await showStatusHeadless();
		return;
	}

	for (;;) {
		const choice = await selectOne(ctx, "wokey.ai", [...MENU]);
		if (choice === null) return; // cancelled
		if (choice === "status") await openStatus(ctx, deps);
		else if (choice === "models") await openModels(ctx);
	}
}