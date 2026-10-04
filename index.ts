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
import { PROVIDER_ID, resolveConfig, type WokeyConfig } from "./config.ts";
import { fetchBalance, WOKEY_API_ROOT, type BalanceInfo } from "./balance.ts";
import { createWokeyProvider, PROVIDER_NAME } from "./provider.ts";
import type { ProofReport } from "./verify/probe.ts";
import { MARK, runMenu, type CommandContext } from "./tui.ts";

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

	const notify = (message: string): void => {
		try {
			ui?.notify(message, "info");
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
			warn(report);
			if (report.status === "unproven" && unprovenWarned) return;
			if (report.status === "unproven") unprovenWarned = true;
		}
	};

	function warn(report: ProofReport): void {
		const failed = report.checks.filter((c) => !c.ok);
		const detail = failed.length > 0 ? failed.map((c) => `${c.name}: ${c.detail}`).join("; ") : (report.reason ?? "no detail");
		const headline = report.status === "unproven" ? "response is not attested" : "verification failed";
		const line = `${MARK[report.status]} wokey ${headline} — ${detail}`;
		// ui.notify is a no-op in --print mode, so mirror to stderr: a proof verdict
		// you cannot see is not a verdict.
		try {
			process.stderr.write(`[wokey] ${line}\n`);
		} catch {
			/* stderr closed */
		}
		notify(line);
	}

	// One native provider for both routes. Auth, model dispatch, and catalog
	// refresh all live inside it; pi owns the credential store and the refresh
	// lifecycle, so there is no unregister/re-register sync here.
	const provider = createWokeyProvider({ config, onReport });
	pi.registerProvider(provider);

	pi.registerCommand("wokey", {
		description: "wokey.ai manager: status, models, set/unset key",
		handler: (args: unknown, ctx: CommandContext) =>
			runMenu(
				{
					config: () => config,
					stats: () => ({ ...stats }),
					last: () => last,
					// Native catalog refresh through pi's model registry: the
					// provider's fetchModels overlays the validated live catalog
					// and retains the last-known lineup on failure.
					refresh: async () => {
						await (ctx as CommandContext).modelRegistry.refresh({ providers: [PROVIDER_ID] });
					},
					balance: () => balance,
					// Credentials come from pi's registry (auth.json / env), never
					// from a second key store kept by this extension.
					syncBalance: async () => {
						await syncBalance(await (ctx as CommandContext).modelRegistry.getApiKeyForProvider(PROVIDER_ID));
					},
				},
				(Array.isArray(args) ? args : String(args ?? "").split(/\s+/)).map(String),
				ctx as CommandContext,
			),
	});

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		notify(`wokey: ${PROVIDER_NAME} ready — ${provider.getModels().length} models, proof probing ${config.verify ? "on" : "off"} (run /wokey for status)`);
		// Fire-and-forget through the native refresh path: a hung relay catalog
		// call must not block session start, and a failure keeps the baked-in lineup.
		void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
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
