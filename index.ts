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
import type { ProofReport } from "./verify/probe.ts";
import { getRoute } from "./routes.ts";
import { MARK, runMenu } from "./tui.ts";

interface Stats {
	verified: number;
	gapped: number;
	failed: number;
	unproven: number;
}

function freshStats(): Stats {
	return { verified: 0, gapped: 0, failed: 0, unproven: 0 };
}

export default function wokeyProvider(pi: ExtensionAPI, config: WokeyConfig = resolveConfig()): void {
	let stats = freshStats();
	let last: ProofReport | undefined;
	/** Last balance read from the relay; `undefined` until one succeeds. */
	let balance: BalanceInfo | undefined;
	let unprovenWarned = false;
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
		stats[report.status === "verified-with-gaps" ? "gapped" : report.status] += 1;
		// Silent on success. "verified-with-gaps" is the documented request-binding gap
		// (see README) — repeating it every turn trains you to ignore warnings, so it is
		// shown in /wokey instead. Warn only on a real problem: failed check or no proof.
		// Verification covers the Claude + GPT routes only: Wokey ships no proofs
		// for Chat Completions vendors (Zhipu, MiniMax, DeepSeek), so their
		// exchanges are unverified by design — recorded and shown in /wokey
		// status, but never warned on. See the README §Reading the verdict note.
		if (getRoute(report.routeId).verification === "none") return;
		if (config.notifyOnFailure && report.status !== "verified" && report.status !== "verified-with-gaps") {
			// "unproven" means the relay sent no proof at all: one notice is enough to
			// know, and a per-turn repeat is noise. Dedup before warning — checking
			// afterwards could never suppress anything.
			if (report.status === "unproven") {
				if (unprovenWarned) return;
				unprovenWarned = true;
			}
			warn(report);
		}
	};

	function warn(report: ProofReport): void {
		const failed = report.checks.filter((c) => !c.ok);
		const detail = failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail}`).join("; ") : (report.reason ?? "no detail");
		const headline = report.status === "unproven" ? "response is not attested" : "verification failed";
		const line = `${MARK[report.status]} wokey ${headline} — ${detail}`;
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
					stats: () => ({ ...stats }),
					last: () => last,
					// Last catalog-overlay warnings, kept by the provider because
					// the native fetchModels path has no warning channel back
					// through pi's registry.
					warnings: () => getLastCatalogWarnings(),
					// Native catalog refresh through pi's model registry: the
					// provider's fetchModels overlays the validated live catalog
					// and retains the last-known lineup on failure.
					refresh: async () => {
						await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
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
		stats: () => ({ ...stats }),
		config: () => ({ ...config }),
		last: () => last,
		provider,
		syncBalance,
		balance: () => balance,
		reset: () => {
			stats = freshStats();
			last = undefined;
			balance = undefined;
		},
	};
}
