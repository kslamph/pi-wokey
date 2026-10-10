/**
 * pi-wokey — wokey.ai's GPT lineup as a pi provider, with every
 * response checked against its Proof-of-Observation statement.
 *
 * The provider is warn-only by design: a response that cannot be proven is
 * surfaced, not suppressed, so a relay outage or a verifier bug degrades into a
 * notification instead of a dead session. Set `verify: false` in config.ts to
 * turn the probe off entirely.
 *
 * What a green report actually means — and what it does not — is in README.md
 * §Trust model. Short version: it establishes "an enclave running the image I
 * pinned fetched these exact bytes from a genuine `chatgpt.com` TLS endpoint".
 * It cannot establish that OpenAI's own servers served the model you asked for;
 * nobody can, because OpenAI does not sign responses.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, loadSettings, resolveConfig, saveSettings, type WokeyConfig } from "./config.ts";
import { fetchBalance, WOKEY_API_ROOT, type BalanceInfo } from "./balance.ts";
import { createWokeyProvider, getLastCatalogWarnings, PROVIDER_NAME } from "./provider.ts";
import { allSpecs, enabledModelIds } from "./models.ts";
import { errorChecks, type ProofReport } from "./verify/probe.ts";
import { getRoute } from "./routes.ts";
import { MARK, runMenu } from "./tui.ts";

/**
 * What an exchange means to the user, collapsed from the four crypto statuses.
 *
 * `verified` and `verified-with-gaps` are the same claim: every check that can
 * be made passed. The documented request-binding rewrite is an accepted
 * structural limit, not a finding, so it no longer gets a colour of its own.
 *
 * `unverifiable` is deliberately *not* `attested`. Wokey publishes no proofs for
 * the Chat Completions vendors, so those answers can carry no attestation at all;
 * counting them as verified would make the word mean nothing.
 */
export type ExchangeOutcome = "attested" | "error" | "unverifiable";

/**
 * Route scope, not report shape: a route wokey documents no proofs for can never
 * produce a verdict, so its `unproven` is a property of the model the user chose,
 * not of the relay's behaviour. This is the same predicate that used to
 * short-circuit the notification, kept in one place so the two cannot drift.
 */
export function classify(report: ProofReport): ExchangeOutcome {
	if (getRoute(report.routeId).verification === "none") return "unverifiable";
	return report.status === "verified" || report.status === "verified-with-gaps" ? "attested" : "error";
}

export interface ExchangeTotals {
	attested: number;
	errors: number;
	unverifiable: number;
	total: number;
}

function freshStats(): ExchangeTotals {
	return { attested: 0, errors: 0, unverifiable: 0, total: 0 };
}

/**
 * How many errors the panel can page through. A misbehaving relay can fail
 * hundreds of exchanges in one session; the panel shows a fixed-size page over
 * this buffer, and beyond it the per-error notifications remain the record.
 */
const ERROR_LOG_CAPACITY = 20;

export default function wokeyProvider(pi: ExtensionAPI, config: WokeyConfig = resolveConfig()): void {
	let totals = freshStats();
	let last: ProofReport | undefined;
	/** Newest-first. Only errors are kept — nothing here is an accepted limit. */
	let errorLog: ProofReport[] = [];
	/** Last balance read from the relay; `undefined` until one succeeds. */
	let balance: BalanceInfo | undefined;
	let ui: { notify(message: string, level?: string): void } | undefined;
	/** Run mode, so a verdict can be routed to the surface that can actually show it. */
	let mode = "tui";

	/**
	 * `notify` is the styled path: pi renders "warning"/"error" into the session
	 * transcript, in theme colours, above the editor. "info" is the dim status
	 * line, and consecutive info lines replace each other — fine for chatter,
	 * wrong for a verdict. Default to "info" so ordinary notices stay quiet.
	 */
	const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
		try {
			ui?.notify(message, type);
		} catch {
			// UI may be gone during reload/shutdown; notifications are best-effort.
		}
	};

	const onReport = (report: ProofReport): void => {
		last = report;
		totals.total += 1;
		const outcome = classify(report);
		totals[outcome === "error" ? "errors" : outcome] += 1;
		// Unverifiable by design: recorded and shown in the panel's acknowledged
		// limits, never an error, never counted as attested, never warned on.
		if (outcome === "unverifiable") return;
		// Attested, including the documented request-binding gap. Silent by design:
		// repeating a non-finding every turn trains you to ignore real warnings, so
		// the accepted limit lives in `/wokey` instead.
		if (outcome === "attested") return;
		errorLog = [report, ...errorLog].slice(0, ERROR_LOG_CAPACITY);
		if (config.notifyOnFailure) warn(report);
	};

	function warn(report: ProofReport): void {
		// Only real failures belong here. An accepted gap and an unchecked anchor
		// are not failures, so neither can reach this line — the panel and the
		// notification now speak from the same classification.
		const failed = errorChecks(report);
		const detail = failed.map((c) => `${c.name}: ${c.detail}`).join("; ") || report.reason || "no detail";
		const headline = report.status === "unproven" ? "response is not attested" : "verification failed";
		const line = `${MARK.failed} wokey ${headline} — ${detail}`;
		// Outside the TUI (pi -p, --json, RPC) ui.notify is a no-op or advisory, so
		// mirror to stderr: a proof verdict you cannot see is not a verdict. In the
		// TUI it must NOT be written — a raw stderr write lands on the cursor pi is
		// painting the editor with and stays there as stray unstyled text.
		if (mode !== "tui" || !ui) {
			try {
				process.stderr.write(`[wokey] ${line}\n`);
			} catch {
				/* stderr closed */
			}
		}
		notify(line, "warning");
	}

	// One native provider for both routes. Auth, model dispatch, and catalog
	// refresh all live inside it; pi owns the credential store and the refresh
	// lifecycle, so there is no unregister/re-register sync here.
	const provider = createWokeyProvider({ config, onReport });
	pi.registerProvider(provider);

	pi.registerCommand("wokey", {
		description: "wokey.ai manager: status, models (credentials via /login wokey)",
		handler: (args, ctx) =>
			runMenu(
				{
					config: () => config,
					errors: () => errorLog,
					last: () => last,
					// Last catalog-overlay warnings, kept by the provider because
					// the native fetchModels path has no warning channel back
					// through pi's registry.
					warnings: () => getLastCatalogWarnings(),
					// Native catalog refresh through pi's model registry: the
					// provider's fetchModels overlays the validated live catalog
					// and retains the last-known lineup on failure. Never rejects,
					// so panel opens and headless renders can sync unconditionally.
					refresh: async () => {
						await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] }).catch(() => {});
					},
					balance: () => balance,
					// Credentials come from pi's registry (auth.json / env), never
					// from a second key store kept by this extension.
					syncBalance: async () => {
						await syncBalance(await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID));
					},
					allModels: () => allSpecs(),
					enabledModels: () => enabledModelIds(),
					// Persist the checked set, then re-register: only the chosen
					// models are offered from here on. A disable cannot strand the
					// session — pi keeps serving the current model until switched.
					saveModels: async (ids: string[]) => {
						saveSettings({ ...loadSettings(), enabledModels: ids });
						await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] }).catch(() => {});
					},
				},
				String(args ?? "").split(/\s+/).map(String),
				ctx,
			),
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		mode = (ctx.mode as string | undefined) ?? "tui";
		notify(`wokey: ${PROVIDER_NAME} ready — ${provider.getModels().length} models, proof probing ${config.verify ? "on" : "off"} (run /wokey for status)`);
		// Fire-and-forget through the native refresh path: a hung relay catalog
		// call must not block session start, and a failure keeps the baked-in lineup.
		void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] }).catch(() => {});
	});

	/**
	 * Best-effort account-balance read for the status panel. Failures leave the
	 * previous value (or none) in place: a balance lookup that fails must not
	 * blank the panel or stall it, and a stale number beats no number.
	 */
	async function syncBalance(key: string | undefined): Promise<void> {
		const next = await fetchBalance(WOKEY_API_ROOT, key);
		if (next) balance = next;
	}

	// Expose for tests / debugging.
	(pi as unknown as { __wokey?: unknown }).__wokey = {
		report: onReport,
		stats: () => ({ ...totals }),
		errors: () => [...errorLog],
		config: () => ({ ...config }),
		last: () => last,
		provider,
		syncBalance,
		balance: () => balance,
		reset: () => {
			totals = freshStats();
			last = undefined;
			errorLog = [];
			balance = undefined;
		},
	};
}
