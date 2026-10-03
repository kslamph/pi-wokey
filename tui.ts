/**
 * /wokey — the whole management UI behind one command.
 *
 * `/wokey` opens a menu, so nothing has to be memorised. The subcommands
 * (`status`, `models`, `key <v>`, `unset`) stay available for scripting and for
 * headless `pi -p`, where there is no UI to draw a menu in.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	clearPiCredential,
	loadSettings,
	maskKey,
	resolveApiKey,
	saveSettings,
	settingsPath,
	resolveConfig,
	writePiCredential,
	type WokeyConfig,
} from "./config.ts";
import { activeSpecs, toModel } from "./models.ts";
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
	/** Re-resolve the key and re-sync the catalog; bound to `r` in the Status panel. */
	refresh(): Promise<void>;
}

// ── renderers (pure, so they are trivially testable and reuseable headlessly) ──

export function renderStatus(config: WokeyConfig, stats: MenuStats, last: ProofReport | undefined): string {
	const settings = loadSettings();
	const key = resolveApiKey();
	const source = key ? (settings.apiKey ? "wokey.json" : "pi auth.json / env") : "not set";
	const lines = [
		`wokey.ai · ${MARK.verified} ${stats.verified}   ${MARK["verified-with-gaps"]} ${stats.gapped}   ${MARK.failed} ${stats.failed}   ${MARK.unproven} ${stats.unproven}`,
		"",
		`key       ${maskKey(key)}  (${source})`,
		`pinned    ${config.expectedPcr0 ? `${config.expectedPcr0.slice(0, 24)}…` : "(unset — model substitution NOT checked)"}`,
		`upstream  ${config.expectedHost}${config.expectedPaths.join("")}`,
		`probing   ${config.verify ? "on (warn-only)" : "off"} · codex envelope ${config.codexEnvelope ? "on" : "off"}`,
		`settings  ${settingsPath()}`,
	];
	if (!last) {
		lines.push("", "No response verified yet this session.");
		return lines.join("\n");
	}
	lines.push(
		"",
		`last      ${MARK[last.status]} ${last.upstreamHost ?? "—"}${last.upstreamPath ?? ""}`,
		`          model ${last.reportedModel ?? "?"} · ${last.bytes} B · ${last.durationMs} ms`,
	);
	for (const c of last.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : ` — ${c.detail}`}`);
	return lines.join("\n");
}

export function renderModels(): string {
	// Rates are USD per 1M; format explicitly so the table aligns and never shows
	// float dust like 0.8999999999999999.
	const money = (n: number): string => `$${n.toFixed(2).replace(/\.?0+$/, "") || "0"}`;
	const rows = activeSpecs().map((s) => {
		// Build the map the same way toModel does, so the listed levels are exactly
		// what pi's picker will offer for this model.
		const levels = getSupportedThinkingLevels(toModel(s, resolveConfig()) as never) as string[];
		return {
			id: s.id,
			name: s.name,
			// spec rates are already USD per 1M tokens — do not scale again.
			in: money(s.input),
			out: money(s.output),
			ctx: s.contextWindow >= 1_000_000 ? `${(s.contextWindow / 1_000_000).toFixed(2)}M` : `${Math.round(s.contextWindow / 1000)}k`,
			levels: levels.join(" "),
		};
	});
	const out = [
		`${"model".padEnd(13)}  ${"in/1M".padEnd(7)}  ${"out/1M".padEnd(8)}  ${"ctx".padEnd(6)}thinking levels`,
		"-".repeat(78),
	];
	for (const r of rows) {
		out.push(`${r.id.padEnd(13)}  ${r.in.padEnd(7)}  ${r.out.padEnd(8)}  ${r.ctx.padEnd(6)}${r.levels}`);
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
 * shows fresh state once `actions.onRefresh` (bound to the `r` key) has run.
 */
function infoPanel(ctx: CommandContext, title: string, getBody: () => string, actions?: { onRefresh?: () => Promise<void> }): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let refreshing = false;
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of getBody().split("\n")) add(` ${line}`);
				add();
				if (refreshing) add(` ${theme.fg("text", "refreshing…")}`);
				else add(` ${theme.fg("text", actions?.onRefresh ? "enter/esc close · r refresh now" : "enter/esc close")}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.return) || matchesKey(data, Key.escape)) {
					done();
					return;
				}
				if (actions?.onRefresh && (data === "r" || data === "R") && !refreshing) {
					refreshing = true;
					tui.requestRender();
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

function openStatus(ctx: CommandContext, deps: MenuDeps): Promise<void> {
	return infoPanel(ctx, "wokey.ai · status", () => renderStatus(deps.config(), deps.stats(), deps.last()), { onRefresh: deps.refresh });
}

function openModels(ctx: CommandContext): Promise<void> {
	return infoPanel(ctx, "wokey.ai · models", () => renderModels());
}

// ── actions ───────────────────────────────────────────────────────────────────

/** Write the key to both stores and describe the result. */
function saveKeyEverywhere(value: string): string {
	// Both stores: pi resolves credentials before it ever reaches streamSimple.
	saveSettings({ ...loadSettings(), apiKey: value });
	writePiCredential(value);
	return `🔑 wokey key saved to ${settingsPath()} and pi's auth.json — ready to use`;
}

/** Remove the key from both stores and describe the result. */
function clearKeyEverywhere(): string {
	const { apiKey: _dropped, ...rest } = loadSettings();
	saveSettings(rest);
	const alsoCleared = clearPiCredential();
	return `🗑 key removed from ${settingsPath()}${alsoCleared ? " and pi's auth.json" : ""}`;
}

async function doSetKey(ctx: CommandContext): Promise<void> {
	const entered = await ctx.ui.input("wokey API key", "sk-…");
	const value = entered?.trim() ?? "";
	if (!value) {
		ctx.ui.notify("wokey: key unchanged", "info");
		return;
	}
	ctx.ui.notify(saveKeyEverywhere(value), "info");
}

async function doUnsetKey(ctx: CommandContext): Promise<void> {
	if (!resolveApiKey()) {
		ctx.ui.notify("wokey: no key is set — nothing to clear", "info");
		return;
	}
	if (!(await ctx.ui.confirm("Clear wokey key", "Remove the stored API key? Requests will fail until you set one again."))) {
		ctx.ui.notify("wokey: key kept", "info");
		return;
	}
	ctx.ui.notify(clearKeyEverywhere(), "info");
}

// ── entry point ───────────────────────────────────────────────────────────────

const USAGE = "usage: /wokey  ·  /wokey status  ·  /wokey models  ·  /wokey key <value>  ·  /wokey unset";

const MENU = [
	{ value: "status", label: "Status — verification counters, key, trust anchors" },
	{ value: "models", label: "Models — lineup, prices, thinking levels" },
	{ value: "key", label: "Set API key" },
	{ value: "unset", label: "Unset API key" },
] as const;

export async function runMenu(deps: MenuDeps, args: string[], ctx: CommandContext): Promise<void> {
	const verb = (args[0] ?? "").toLowerCase();
	const inline = args.slice(1).join(" ").trim();

	const show = (text: string): void => {
		ctx.ui.notify(text, "info");
		if (!ctx.hasUI) process.stderr.write(`${text}\n`);
	};

	// Subcommands stay available for scripting and headless runs; with a UI the
	// info views open as in-TUI panels instead of toasts.
	if (verb === "status") {
		if (ctx.hasUI) await openStatus(ctx, deps);
		else show(renderStatus(deps.config(), deps.stats(), deps.last()));
		return;
	}
	if (verb === "models" || verb === "model" || verb === "list") {
		if (ctx.hasUI) await openModels(ctx);
		else show(renderModels());
		return;
	}
	if (verb === "key" && inline) {
		show(saveKeyEverywhere(inline));
		return;
	}
	if (verb === "key") {
		show(`key: ${maskKey(resolveApiKey())}`);
		return;
	}
	if (verb === "unset" || verb === "clear") {
		if (!resolveApiKey()) {
			show("wokey: no key is set — nothing to clear");
			return;
		}
		show(clearKeyEverywhere());
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
		show(renderStatus(deps.config(), deps.stats(), deps.last()));
		return;
	}

	for (;;) {
		const choice = await selectOne(ctx, "wokey.ai", [...MENU]);
		if (choice === null) return; // cancelled
		if (choice === "status") await openStatus(ctx, deps);
		else if (choice === "models") await openModels(ctx);
		else if (choice === "key") await doSetKey(ctx);
		else if (choice === "unset") await doUnsetKey(ctx);
	}
}