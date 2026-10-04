import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Configuration + trust anchors for the wokey.ai provider.
 *
 * ── The one thing that matters here ───────────────────────────────────────────
 * `EXPECTED_PCR0` is the audited enclave measurement. It is a hardcoded constant
 * and is NEVER read from a proof, a response header, or the relay's website.
 * That is the single defect that makes wokey's own browser verifier
 * (`focuxdot/proof-of-observation` docs/tee-verify.html) pass vacuously: its
 * `expectedPcr0FromObject()` falls back to `proof.pcr0`, so the value under test
 * is adopted from the artifact being judged.
 *
 * The value below is the one published in the project's `docs/tee-reproducible-build.md`
 * for measured revision 03fe2a3eb6d05e1ec94f7f52ac0521d42560a731. It is still an
 * *operator-published* value, so it inherits trust in the operator (spec §10.6).
 * See README.md §Trust model for how to replace it with a value you derived
 * yourself from a reproducible build.
 */

export interface WokeyConfig {
	/**
	 * The audited enclave measurement to compare against. Hardcoded on purpose —
	 * see the file header. Empty string disables the PCR0 gate (everything else
	 * still runs, and the report says so).
	 */
	expectedPcr0: string;
	/**
	 * Header that asks the relay to select a proof transport. The provider strips
	 * it from outgoing requests and relies on the relay default: a trailing
	 * `event: tee.proof` SSE record, which the probe strips before pi sees it.
	 * Multipart proof delivery is deliberately not negotiable through this provider.
	 */
	proofHeaderName: string;
	/** Verify on every response (default true). */
	verify: boolean;
	/** Surface a notification when a response fails verification (default true). */
	notifyOnFailure: boolean;
}

/** Published production PCR0 for measured revision 03fe2a3eb6d05e1ec94f7f52ac0521d42560a731. */
export const PUBLISHED_PCR0 =
	"437cbab8c2e5dd11a35ae5b062fe115623a013910b7c26b333e2b3af477944d630fb1dcd76fa9a9b1eefdf1d1021dec2";

export const PROVIDER_ID = "wokey";

export const DEFAULT_CONFIG: WokeyConfig = {
	expectedPcr0: PUBLISHED_PCR0,
	proofHeaderName: "x-wokey-tee-proof-mode",
	verify: true,
	notifyOnFailure: true,
};

// ── settings store ─────────────────────────────────────────────────────────────

/**
 * Verification preferences live in `~/.pi/agent/wokey.json`, alongside `auth.json`
 * and the other per-extension state files pi already keeps there. The API key
 * never lives here — credentials are pi-managed (`/login wokey`). Nothing is
 * read from the current working directory or a
 * project-local `.env`, so the extension behaves identically no matter where pi
 * was launched from.
 */
export function settingsPath(): string {
	return process.env.WOKEY_CONFIG ?? join(homedir(), ".pi", "agent", "wokey.json");
}

export interface WokeySettings {
	/**
	 * Local verification preferences only. Credentials are pi-managed
	 * (`/login wokey`) and never live here.
	 */
	expectedPcr0?: string;
	verify?: boolean;
	notifyOnFailure?: boolean;
	/**
	 * Model ids registered with pi, chosen in the `/wokey models` selector.
	 * Absent means the verified default lineup. Unknown ids are ignored.
	 */
	enabledModels?: string[];
}

export function loadSettings(): WokeySettings {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		// Pick only the current schema: a leftover `apiKey` and the old
		// route/trust overrides (baseUrl, api, expectedHost(s), expectedPaths,
		// codexEnvelope) are ignored, never migrated and never used as a
		// credential. An old settings file keeps working for preferences; the
		// key is re-entered through pi auth (`/login wokey`).
		const raw = parsed as Record<string, unknown>;
		const out: WokeySettings = {};
		if (typeof raw.expectedPcr0 === "string") out.expectedPcr0 = raw.expectedPcr0;
		if (typeof raw.verify === "boolean") out.verify = raw.verify;
		if (typeof raw.notifyOnFailure === "boolean") out.notifyOnFailure = raw.notifyOnFailure;
		if (Array.isArray(raw.enabledModels) && raw.enabledModels.every((id) => typeof id === "string")) {
			out.enabledModels = [...raw.enabledModels];
		}
		return out;
	} catch {
		return {}; // missing or malformed is not fatal; defaults still work
	}
}

/**
 * Persist verification preferences (including the selector's model choice).
 * Preferences only — credentials never live here (`/login wokey` owns those).
 */
export function saveSettings(settings: WokeySettings): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Detect a leftover `apiKey` in an old settings file. The value is never read
 * as a credential — credentials come only from pi's registry (`/login wokey`).
 * This exists purely so the status panel can tell the user to re-enter the key
 * through pi auth and drop the stale entry.
 */
export function hasLegacyApiKey(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const key = (parsed as Record<string, unknown>).apiKey;
		return typeof key === "string" && key.trim().length > 0;
	} catch {
		return false; // missing or malformed: nothing to re-enter
	}
}

export function resolveConfig(overrides?: Partial<WokeyConfig>): WokeyConfig {
	const settings = loadSettings();
	// Env override exists so the PCR0 gate can be exercised deliberately in a test
	// without editing source. Unset in normal use.
	const envPcr0 = process.env.WOKEY_EXPECTED_PCR0?.trim();
	return {
		...DEFAULT_CONFIG,
		...(typeof settings.verify === "boolean" ? { verify: settings.verify } : {}),
		...(typeof settings.notifyOnFailure === "boolean" ? { notifyOnFailure: settings.notifyOnFailure } : {}),
		...(settings.expectedPcr0 ? { expectedPcr0: settings.expectedPcr0.toLowerCase() } : {}),
		...(envPcr0 ? { expectedPcr0: envPcr0.toLowerCase() } : {}),
		...(process.env.WOKEY_NO_VERIFY === "1" ? { verify: false } : {}),
		...overrides,
	};
}