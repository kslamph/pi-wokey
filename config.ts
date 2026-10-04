import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * Settings and the API key live in `~/.pi/agent/wokey.json`, alongside `auth.json`
 * and the other per-extension state files pi already keeps there. Nothing is read
 * from the current working directory or a project-local `.env`, so the extension
 * behaves identically no matter where pi was launched from.
 */
export function settingsPath(): string {
	return process.env.WOKEY_CONFIG ?? join(homedir(), ".pi", "agent", "wokey.json");
}

export interface WokeySettings {
	/** API key for api.wokey.ai. Optional — pi's own auth.json entry for `wokey` also works. */
	apiKey?: string;
	expectedPcr0?: string;
	verify?: boolean;
	notifyOnFailure?: boolean;
}

export function loadSettings(): WokeySettings {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		// Pick only the current schema: keys from the old route/trust overrides
		// (baseUrl, api, expectedHost(s), expectedPaths, codexEnvelope) are ignored,
		// never migrated. An old settings file keeps working for preferences; the
		// key is re-entered through pi auth (Task 6 removes the duplicate store).
		const raw = parsed as Record<string, unknown>;
		const out: WokeySettings = {};
		if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
		if (typeof raw.expectedPcr0 === "string") out.expectedPcr0 = raw.expectedPcr0;
		if (typeof raw.verify === "boolean") out.verify = raw.verify;
		if (typeof raw.notifyOnFailure === "boolean") out.notifyOnFailure = raw.notifyOnFailure;
		return out;
	} catch {
		return {}; // missing or malformed is not fatal; defaults still work
	}
}

export function saveSettings(settings: WokeySettings): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600); // the file may hold an API key
}

/** Never print a whole key. */
export function maskKey(key: string | undefined): string {
	if (!key) return "(unset)";
	if (key.length <= 10) return `${key.slice(0, 2)}…(${key.length})`;
	return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * Resolution order: this extension's settings, then pi's credential store (which is
 * what actually authenticates requests), then the environment.
 *
 * This sits on the per-request path (`stream.ts` falls back to it), so the two
 * credential files are re-read only when their metadata (or the env fallback)
 * changes. `/wokey key` rewrites the settings file, bumping its mtime and
 * invalidating the cache naturally.
 */
let apiKeyCache: { key: string | undefined; stamp: string } | undefined;

function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

export function resolveApiKey(): string | undefined {
	const settings = settingsPath();
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	const stamp = `${mtimeMs(settings)}:${mtimeMs(authPath)}:${process.env.WOKEY_API_KEY ?? ""}`;
	if (apiKeyCache?.stamp === stamp) return apiKeyCache.key;

	let key = loadSettings().apiKey?.trim() || undefined;
	if (!key) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
			const entry = auth?.wokey;
			if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim()) key = entry.key.trim();
		} catch {
			/* fall through to env */
		}
	}
	if (!key) key = process.env.WOKEY_API_KEY?.trim() || undefined;

	apiKeyCache = { key, stamp };
	return key;
}

/**
 * pi resolves credentials from its own store *before* calling a provider's
 * streamSimple (`model-registry.js:33-41`: no resolution → hard "No API key found").
 * So a key that only lives in `wokey.json` would never be used. `/wokey key` therefore
 * writes both stores; this helper keeps the two in step without clobbering other
 * providers' entries.
 */
export function writePiCredential(key: string): void {
	const path = join(homedir(), ".pi", "agent", "auth.json");
	let auth: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) auth = parsed as Record<string, unknown>;
	} catch {
		/* absent or malformed: start a fresh store rather than refusing to save */
	}
	auth[PROVIDER_ID] = { type: "api_key", key };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function clearPiCredential(): boolean {
	const path = join(homedir(), ".pi", "agent", "auth.json");
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!(PROVIDER_ID in parsed)) return false;
		delete parsed[PROVIDER_ID];
		writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
		return true;
	} catch {
		return false;
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