/**
 * /wokey — the whole management UI behind one command.
 *
 * `/wokey` opens a menu, so nothing has to be memorised. The subcommands
 * (`status`, `models`) stay available for scripting and for headless `pi -p`,
 * where there is no UI to draw a menu in. Credentials are pi-managed
 * (`/login wokey`) — this extension never touches them, so
 * the old `/wokey key` / `/wokey unset` verbs only point at pi auth now.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { hasLegacyApiKey, loadSettings, saveSettings, settingsPath, type WokeyConfig } from "./config.ts";
import { activeSpecs, allSpecs, enabledModelIds, toModel, type WokeyModelSpec } from "./models.ts";
import { getRoute } from "./routes.ts";
import type { BalanceInfo } from "./balance.ts";
import { errorChecks, type ProofReport } from "./verify/probe.ts";

export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export const MARK = {
	verified: "✅",
	failed: "❌",
} as const;

/**
 * Errors per page in the error log.
 *
 * `Component.render(width)` is handed a width and nothing else — no height, no
 * viewport size — so a panel cannot scroll itself and cannot know how much of it
 * the terminal will show. The page size is therefore fixed, and paging is
 * declared in the footer only when the log does not fit.
 */
export const PAGE_SIZE = 3;

/** Body text wraps here; verified to fit widths 100 and 112 without truncation. */
const WRAP = 76;

export interface MenuDeps {
	config(): WokeyConfig;
	/** Newest-first error log; only real failures, never an accepted limit. */
	errors(): readonly ProofReport[];
	last(): ProofReport | undefined;
	/** Last catalog-overlay warnings, kept by the provider (see provider.ts). */
	warnings(): string[];
	/**
	 * Re-sync the catalog through pi's model registry, so the rates on screen
	 * are the relay's current peak/off-peak readout, not the baked-in table.
	 * Runs when either panel opens and on every headless render, repaints on
	 * arrival, and never rejects: a failed sync keeps the last-known lineup.
	 */
	refresh(): Promise<void>;
	/** Last known account balance, or `undefined` if it was never read. Re-read on every render. */
	balance(): BalanceInfo | undefined;
	/** Read the balance from the relay; runs when the panel opens and on `r`. Never rejects. */
	syncBalance(): Promise<void>;
	/** Every known model row for the selector, verified lineup first. */
	allModels(): WokeyModelSpec[];
	/** Currently registered model ids (the selector's checked set). */
	enabledModels(): Set<string>;
	/**
	 * Persist the selector's checked set and re-register through pi's model
	 * registry, so only the chosen models are offered. Never rejects.
	 */
	saveModels(ids: string[]): Promise<void>;
}

export interface StatusOptions {
	/** Account balance to show. `undefined` renders a dash, never a blank. */
	balance?: BalanceInfo;
	/** Last catalog-overlay warnings; rendered as their own section. */
	warnings?: string[];
	/**
	 * A leftover `apiKey` in an old `wokey.json` was detected. Set by the
	 * status entry point (one `hasLegacyApiKey()` read per panel open);
	 * defaults to false so the renderer stays pure. Pass explicitly in tests.
	 */
	legacyKey?: boolean;
	/** Newest-first error log. Only real failures — never an accepted limit. */
	errors?: readonly ProofReport[];
	/** Which page of the error log to show. Clamped here, so the renderer stays pure. */
	cursor?: number;
}

// ── renderers (pure, so they are trivially testable and reuseable headlessly) ──

/** USD for a money amount: always cents. A balance of exactly $5 reads "$5.00",
 * not "$5" — trimming zeros is for the Models rate table, not for what you owe. */
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Byte counts as a person reads them: exact under 1 kB, rounded above. */
const bytes = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`);

/** Latency in ms, switching to seconds only once ms stops being readable. */
const millis = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

/** Wall-clock of a finished exchange, so errors can be placed within a session. */
const clock = (epochMs: number): string => {
	const d = new Date(epochMs);
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Greedy wrap with the continuation aligned under the first word, so a wrapped
 * reason still reads as one statement. No line this produces exceeds `WRAP`.
 */
function wrap(text: string, head: string, width = WRAP): string[] {
	const indent = head.length;
	const out: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (line && indent + line.length + 1 + word.length > width) {
			out.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) out.push(line);
	return out.map((l, i) => (i === 0 ? head + l : " ".repeat(indent) + l));
}

/** Where an exchange was served, for an error card that has no proof to quote. */
function endpointOf(report: ProofReport): string {
	if (!report.upstreamHost) return getRoute(report.routeId).id;
	return `${report.upstreamHost}${report.upstreamPath ?? ""}${report.upstreamMethod ? ` ${report.upstreamMethod}` : ""}`;
}

/**
 * The status view, answering exactly one question: did an exchange that was
 * supposed to verify actually fail?
 *
 * The panel is held to one rule — everything on it must be *surprising and new*.
 * Text that is identical on every open (the pinned PCR0, the three upstream
 * tuples, the auth line, the settings path, the names of the eleven checks, the
 * accepted-limits prose) is documentation, not status: it costs the reader lines
 * to re-read and can never change what they do. That material lives in README
 * §Trust model instead. What stays is per-exchange (errors, the last exchange),
 * a number the reader wants (balance), and the handful of conditions that are
 * only rendered when they are actually true.
 *
 * No counter row either. Errors are listed, and a list is its own count — a tally
 * beside it added nothing a reader could act on, and the four-glyph legend it
 * replaced was read as 31 problems on a completely healthy session.
 *
 * Block order is deliberate: the component is handed no height, so an overflowing
 * body loses its *tail* — the least important block goes last.
 */
export function renderStatus(config: WokeyConfig, last: ProofReport | undefined, opts: StatusOptions = {}): string {
	const legacyKey = opts.legacyKey ?? false;
	const warnings = opts.warnings ?? [];
	const errors = opts.errors ?? [];
	const balance = opts.balance
		? `${usd(opts.balance.availableUsd)} available${opts.balance.reservedUsd > 0 ? ` · ${usd(opts.balance.reservedUsd)} reserved` : ""}`
		: "—";
	const lines: string[] = [];

	// ── errors, or the reassuring last exchange in their place ────────────────
	const pages = Math.max(1, Math.ceil(errors.length / PAGE_SIZE));
	const page = Math.min(Math.max(opts.cursor ?? 0, 0), pages - 1);
	const shown = errors.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

	if (errors.length === 0) {
		// "No errors" would be a claim about a session that never ran, so an empty
		// log with no exchange says what is actually true.
		lines.push(last ? "no errors this session" : "no exchange yet this session");
		if (last) {
			// Name the checks that did not run, rather than listing all eleven every
			// turn: the count is per-exchange news, the roster is not.
			const skipped = last.checks.filter((c) => !c.ok);
			const why = skipped.map((c) => `${c.name} ${c.severity === "gap" ? "not checkable" : "not checked"}`).join(", ");
			lines.push(
				"",
				`last    ${endpointOf(last)}`,
				`        ${last.reportedModel ?? "?"} · ${bytes(last.bytes)} · ${millis(last.durationMs)}`,
				...wrap(`${MARK.verified} verified · ${last.checks.length - skipped.length} of ${last.checks.length} checks${why ? ` · ${why}` : ""}`, "        "),
			);
		}
	} else {
		// The count appears only once the log cannot be read in one page, and then
		// as a position rather than a bare total.
		lines.push(
			pages > 1
				? `errors ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${errors.length}`
				: `error${errors.length === 1 ? "" : "s"}`,
		);
		lines.push("");
		for (const report of shown) {
			lines.push(`  ${clock(report.finishedAt)} · ${endpointOf(report)}`);
			for (const c of errorChecks(report)) lines.push(...wrap(`${c.name} — ${c.detail}`, "    ✗ "));
			// A fault in our own reader is not a verdict on wokey and must not read as
			// one. Annotated on the card, where it cannot be missed.
			if (report.reason === "could not read response for verification") {
				lines.push(...wrap("not a verdict on wokey — the answer was delivered unchecked", "      "));
			}
			lines.push(`      ${report.reportedModel ?? "?"} · ${bytes(report.bytes)} · ${millis(report.durationMs)}`);
		}
	}

	lines.push("", `balance  ${balance}`);

	if (legacyKey) {
		lines.push(
			`[!] a legacy key is still stored in ${settingsPath()} — re-enter it with /login wokey, then delete the apiKey entry`,
		);
	}
	if (warnings.length > 0) {
		lines.push("", "catalog warnings:");
		for (const w of warnings) lines.push(...wrap(w, "  ! "));
	}

	// ── Conditions, not documentation. Each of these renders only when it is
	//    actually true, so the panel never spends a line on the default case.
	//
	// Verification switched off is the most surprising thing this extension can
	// be in, and it used to hide behind a static `probing on (warn-only)` row.
	if (!config.verify) {
		lines.push("", "verification is OFF — responses are not checked at all");
	}
	// An unset anchor shrinks the claim; it is the exchange's misconfiguration to
	// report as such, never a failed exchange.
	if (!config.expectedPcr0) {
		lines.push("");
		lines.push("verification is weaker than intended");
		lines.push(
			...wrap(
				`no audit PCR0 is pinned, so enclave image substitution is not checked. Set expectedPcr0 in ${settingsPath()}.`,
				"  ",
			),
		);
	}

	// Everything else that used to live here is static and is gone: the pinned
	// PCR0 (a compiled constant), the three upstream tuples (code-pinned), the
	// auth line, the settings path, the roster of eleven check names, and the
	// accepted-limits prose. None of it can change what the reader does, and all
	// of it is in README §Trust model. The one fact from that material worth
	// keeping is per-exchange, and it is on the verdict line above.
	return lines.join("\n");
}

/**
 * The keys this panel actually has. Paging is advertised only when the log
 * overflows a page, so the ordinary case offers no scroll affordance at all.
 */
export function statusFooter(errorCount: number): string {
	const keys = ["enter/esc close"];
	if (errorCount > PAGE_SIZE) keys.push("↑/↓ error", "pgup/pgdn");
	return keys.join(" · ");
}

/**
 * Best-effort catalog re-sync for the headless renders: a failed sync keeps
 * the last-known lineup, so scripting never breaks on a relay hiccup.
 */
async function refreshBestEffort(deps: MenuDeps): Promise<void> {
	try {
		await deps.refresh();
	} catch {
		// Keep the last-known catalog; the overlay is best-effort.
	}
}

/** Rate table money: USD per 1M, trailing zeros trimmed but precision kept —
 * sub-cent vendor rates like $0.075 or $0.112 must survive formatting. */
const money = (n: number): string => `$${n.toFixed(5).replace(/\.?0+$/, "") || "0"}`;

/** One lineup row, shared by the headless table and the interactive selector. */
function modelRow(s: WokeyModelSpec, money: (n: number) => string): {
	id: string; vendor: string; api: string; in: string; out: string; ctx: string; levels: string; unverified: boolean;
} {
	// Build the map the same way toModel does, so the listed levels are exactly
	// what pi's picker will offer for this model.
	const levels = getSupportedThinkingLevels(toModel(s) as never) as string[];
	return {
		id: s.id,
		vendor: s.vendor,
		api: getRoute(s.route).api,
		// spec rates are already USD per 1M tokens — do not scale again.
		in: money(s.input),
		out: money(s.output),
		ctx: s.contextWindow >= 1_000_000 ? `${(s.contextWindow / 1_000_000).toFixed(2)}M` : `${Math.round(s.contextWindow / 1000)}k`,
		levels: levels.join(" "),
		unverified: getRoute(s.route).verification === "none",
	};
}

export function renderModels(): string {
	const rows = activeSpecs().map((s) => modelRow(s, money));
	const out = [
		`${"model".padEnd(15)}  ${"vendor".padEnd(9)}  ${"api".padEnd(18)}  ${"in/1M".padEnd(7)}  ${"out/1M".padEnd(8)}  ${"ctx".padEnd(6)}thinking levels`,
		"-".repeat(107),
	];
	for (const r of rows) {
		out.push(
			`${r.id.padEnd(15)}  ${r.vendor.padEnd(9)}  ${r.api.padEnd(18)}  ${r.in.padEnd(7)}  ${r.out.padEnd(8)}  ${r.ctx.padEnd(6)}${r.levels}${r.unverified ? "   [unverified]" : ""}`,
		);
	}
	out.push("", `Select one with /model, e.g.  /model wokey/gpt-6-luna:high`);
	out.push("Pick the lineup in /wokey → Models. Rates are re-read from GET /v1/models on every startup and every time /wokey opens, and each turn is priced at the current catalog rate (wokey uses dynamic_discount).");
	out.push("Zhipu/MiniMax/DeepSeek rows are unverified by design — Wokey ships no proofs for them, and they never warn.");
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
 * `onMount` runs once when the panel opens, for the fire-and-forget refreshes
 * that repaint on arrival. `paged` adds a cursor the arrow and page keys move;
 * the body is handed it and the cursor is clamped on every read, so a shrinking
 * error log can never strand the view on a page that no longer exists.
 *
 * There is deliberately no fold key and no manual refresh key: the status panel
 * has no static detail left to disclose, and entering it already re-reads
 * everything it shows.
 */
function infoPanel(
	ctx: CommandContext,
	title: string,
	getBody: (cursor: number) => string,
	actions?: { onMount?: (tui: { requestRender(): void }) => void; paged?: () => number },
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let cursor = 0;
		actions?.onMount?.(tui);
		const pageCount = (): number => Math.max(1, Math.ceil((actions?.paged?.() ?? 0) / PAGE_SIZE));
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of getBody(cursor).split("\n")) add(` ${line}`);
				add();
				add(` ${theme.fg("text", statusFooter(actions?.paged?.() ?? 0))}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.return) || matchesKey(data, Key.escape)) {
					done();
					return;
				}
				// Paging first, and only for the keys that mean something here: the
				// clamp keeps `end` and `pageDown` from running off the end, and a
				// single-page log keeps every key a no-op.
				const pages = pageCount();
				if (pages > 1) {
					if (matchesKey(data, Key.down)) cursor = Math.min(cursor + 1, pages - 1);
					else if (matchesKey(data, Key.up)) cursor = Math.max(cursor - 1, 0);
					else if (matchesKey(data, Key.pageDown)) cursor = Math.min(cursor + 1, pages - 1);
					else if (matchesKey(data, Key.pageUp)) cursor = Math.max(cursor - 1, 0);
					else if (matchesKey(data, Key.end)) cursor = pages - 1;
					else if (matchesKey(data, Key.home)) cursor = 0;
				}
				tui.requestRender();
			},
		};
	});
}

/**
 * Opening the panel re-reads the balance and the catalog and repaints on
 * arrival, so neither number is older than the visit — there is no manual
 * refresh key to remember.
 */
function openStatus(ctx: CommandContext, deps: MenuDeps): Promise<void> {
	// One disk read per panel open, not per render: renderStatus is pure.
	const legacyKey = hasLegacyApiKey();
	return infoPanel(
		ctx,
		"wokey.ai · status",
		(cursor) =>
			renderStatus(deps.config(), deps.last(), {
				balance: deps.balance(),
				warnings: deps.warnings(),
				legacyKey,
				errors: deps.errors(),
				cursor,
			}),
		{
			onMount: (t) => {
				void Promise.all([deps.syncBalance(), refreshBestEffort(deps)]).finally(() => t.requestRender());
			},
			paged: () => deps.errors().length,
		},
	);
}

/**
 * The lineup selector, grouped by vendor. Opening it re-reads the catalog so
 * the rates are the relay's current peak/off-peak readout — DeepSeek rows move
 * on a daily schedule, and a baked-in price can go stale mid-session. The panel
 * opens immediately on the last-known lineup and repaints when the sync lands;
 * a failed sync keeps the old numbers rather than blanking the panel.
 */
function openModels(ctx: CommandContext, deps: MenuDeps): Promise<void> {
	const specs = deps.allModels();
	const vendors = [...new Set(specs.map((s) => s.vendor))];
	const checked = new Set(deps.enabledModels());
	let vendorIdx = 0;
	let cursor = 0;
	// Rows read the live spec objects on every render (refreshFromCatalog moves
	// them in place), so a repaint is all it takes to show the synced rates.
	let refreshing = true;
	let requestRender = () => {};
	void refreshBestEffort(deps).finally(() => {
		refreshing = false;
		requestRender();
	});
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		requestRender = () => tui.requestRender();
		// Rows follow the active tab: recomputed on every render, never captured.
		const rows = (): WokeyModelSpec[] => specs.filter((s) => s.vendor === vendors[vendorIdx]);
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold("wokey.ai · models"))}   ${vendors.map((v, i) => (i === vendorIdx ? theme.fg("accent", `[${v}]`) : ` ${v} `)).join(" ")}`);
				add();
				const visible = rows();
				visible.forEach((s, i) => {
					const r = modelRow(s, money);
					const pointer = i === cursor ? theme.fg("accent", "❯") : " ";
					const box = checked.has(s.id) ? theme.fg("accent", "[×]") : "[ ]";
					add(` ${pointer} ${box} ${(r.id.padEnd(15))}  ${r.api.padEnd(18)}  ${r.in.padEnd(7)}  ${r.out.padEnd(8)}  ${r.ctx.padEnd(6)}${r.levels}${r.unverified ? "   [unverified]" : ""}`);
				});
				add();
				const first = rows()[0];
				if (first && getRoute(first.route).verification === "none") {
					add(` ${theme.fg("text", "responses unverified by design — no proofs, never warns")}`);
				}
				add(` ${theme.fg("text", `←/→ vendor · ↑/↓ move · space toggle · enter save (${checked.size} on) · esc cancel${refreshing ? " · refreshing live rates…" : ""}`)}`);
				return lines;
			},
			invalidate() {},
				handleInput(data: string) {
				const vendorRows = rows();
				if (matchesKey(data, Key.left)) vendorIdx = (vendorIdx + vendors.length - 1) % vendors.length;
				else if (matchesKey(data, Key.right)) vendorIdx = (vendorIdx + 1) % vendors.length;
				else if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
				else if (matchesKey(data, Key.down)) cursor = Math.min(vendorRows.length - 1, cursor + 1);
				else if (matchesKey(data, Key.space)) {
					const id = vendorRows[cursor]?.id;
					if (id) {
						if (checked.has(id)) checked.delete(id);
						else checked.add(id);
					}
				} else if (matchesKey(data, Key.return)) {
					// Persist, re-register through pi, then close: only the checked
					// models are offered from here on.
					void deps.saveModels([...checked]).finally(() => done());
					return;
				} else if (matchesKey(data, Key.escape)) {
					done();
					return;
				}
				// A vendor switch lands on its first row; a shorter list clamps.
				cursor = Math.min(cursor, Math.max(0, rows().length - 1));
				tui.requestRender();
			},
		};
	});
}

// ── entry point ───────────────────────────────────────────────────────────────

const USAGE = "usage: /wokey  ·  /wokey status  ·  /wokey models   (credentials via /login wokey, /logout wokey)";

const MENU = [
	{ value: "status", label: "Status — errors, latest exchange, balance" },
	{ value: "models", label: "Models — pick lineup by vendor" },
] as const;

/**
 * The retired duplicate key store: credentials are pi-managed, so these verbs
 * only point at pi auth. They stay (instead of falling through to USAGE) so a
 * user typing the old command learns where the key went.
 */
function keyGuidance(verb: string): string {
	return verb === "key"
		? "wokey: API keys are managed by pi — run /login wokey. The old /wokey key store is retired."
		: "wokey: API keys are managed by pi — run /logout wokey to remove the key. The old /wokey unset store is retired.";
}

export async function runMenu(deps: MenuDeps, args: string[], ctx: CommandContext): Promise<void> {
	const verb = (args[0] ?? "").toLowerCase();

	const show = (text: string): void => {
		ctx.ui.notify(text, "info");
		if (!ctx.hasUI) process.stderr.write(`${text}\n`);
	};

	/** Headless status: no panel to repaint, so sync once and print. */
	const showStatusHeadless = async (): Promise<void> => {
		await deps.syncBalance();
		await refreshBestEffort(deps);
		show(
			renderStatus(deps.config(), deps.last(), {
				balance: deps.balance(),
				warnings: deps.warnings(),
				legacyKey: hasLegacyApiKey(),
				errors: deps.errors(),
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
		if (ctx.hasUI) await openModels(ctx, deps);
		else {
			await refreshBestEffort(deps);
			show(renderModels());
		}
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
		else if (choice === "models") await openModels(ctx, deps);
	}
}