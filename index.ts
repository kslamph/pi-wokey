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
import { PROVIDER_ID, resolveApiKey, resolveConfig, type WokeyConfig } from "./config.ts";
import { fetchBalance, type BalanceInfo } from "./balance.ts";
import { activeModels, refreshFromCatalog } from "./models.ts";
import { createWokeyStream } from "./stream.ts";
import type { ProofReport } from "./verify/probe.ts";
import { MARK, runMenu, type CommandContext } from "./tui.ts";

export const PROVIDER_NAME = "wokey.ai (verified)";

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

	const streamSimple = createWokeyStream({ config, onReport });

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: config.baseUrl,
		api: config.api,
		models: activeModels(config),
		streamSimple,
	});

	pi.registerCommand("wokey", {
		description: "wokey.ai manager: status, models, set/unset key",
		handler: (args: unknown, ctx: CommandContext) =>
			runMenu(
				{
					config: () => config,
					stats: () => ({ ...stats }),
					last: () => last,
					refresh: () => syncCatalog(),
					balance: () => balance,
					syncBalance: () => syncBalance(),
				},
				(Array.isArray(args) ? args : String(args ?? "").split(/\s+/)).map(String),
				ctx as CommandContext,
			),
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		mode = (ctx.mode as string | undefined) ?? "tui";
		notify(`wokey: ${PROVIDER_NAME} ready — ${activeModels(config).length} GPT models, proof probing ${config.verify ? "on" : "off"} (run /wokey for status)`);
		// Fire-and-forget: a hung relay catalog call must not block session start.
		void syncCatalog();
	});

	/** Best-effort reconciliation of context limits and rates against the live catalog. */
	async function syncCatalog(): Promise<void> {
		const key = resolveApiKey();
		if (!key) return;
		try {
			const res = await fetch(`${config.baseUrl}/models`, {
				headers: { authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(2000),
			});
			if (!res.ok) return;
			const { updated, warnings } = refreshFromCatalog(await res.json());
			for (const w of warnings) notify(`wokey: ${w}`, "warning");
			if (updated.length > 0) pi.unregisterProvider(PROVIDER_ID);
			pi.registerProvider(PROVIDER_ID, {
				name: PROVIDER_NAME,
				baseUrl: config.baseUrl,
				api: config.api,
				models: activeModels(config),
				streamSimple,
			});
		} catch {
			// Keep the baked-in lineup; a catalog hiccup must not break startup.
		}
	}

	/**
	 * Best-effort account-balance read for the status panel. Failures leave the
	 * previous value (or none) in place: a balance lookup that fails must not
	 * blank the panel or stall it, and a stale number beats no number.
	 */
	async function syncBalance(): Promise<void> {
		const next = await fetchBalance(config, resolveApiKey());
		if (next) balance = next;
	}

	// Expose for tests / debugging.
	(pi as unknown as { __wokey?: unknown }).__wokey = {
		report: onReport,
		stats: () => ({ ...stats }),
		config: () => ({ ...config }),
		last: () => last,
		syncCatalog,
		syncBalance,
		balance: () => balance,
		reset: () => {
			stats = freshStats();
			last = undefined;
			balance = undefined;
		},
	};
}