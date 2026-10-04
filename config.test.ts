/**
 * Configuration holds only shared verification preferences. Credentials live in
 * pi's own store (`/login wokey`) — this module never reads or
 * writes an API key. The one exception is `hasLegacyApiKey`, which detects a
 * leftover `apiKey` in an old settings file purely so the UI can tell the user
 * to re-enter it via `/login wokey`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, hasLegacyApiKey, loadSettings, PUBLISHED_PCR0, resolveConfig } from "./config.ts";

let dir: string;
let file: string;
const prev = process.env.WOKEY_CONFIG;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wokey-config-"));
	file = join(dir, "wokey.json");
	process.env.WOKEY_CONFIG = file;
});

afterEach(() => {
	if (prev === undefined) delete process.env.WOKEY_CONFIG;
	else process.env.WOKEY_CONFIG = prev;
	rmSync(dir, { recursive: true, force: true });
});

describe("legacy key detection", () => {
	it("reports no legacy key when the settings file is absent", () => {
		expect(hasLegacyApiKey()).toBe(false);
	});

	it("reports a legacy key left in an old settings file", () => {
		writeFileSync(file, JSON.stringify({ apiKey: "sk-leftover" }));
		expect(hasLegacyApiKey()).toBe(true);
	});

	it("ignores empty or non-string apiKey values", () => {
		writeFileSync(file, JSON.stringify({ apiKey: "   " }));
		expect(hasLegacyApiKey()).toBe(false);
		writeFileSync(file, JSON.stringify({ apiKey: 42 }));
		expect(hasLegacyApiKey()).toBe(false);
		writeFileSync(file, JSON.stringify({ verify: false }));
		expect(hasLegacyApiKey()).toBe(false);
	});

	it("ignores malformed settings files", () => {
		writeFileSync(file, "not json{");
		expect(hasLegacyApiKey()).toBe(false);
	});
});

describe("reduced configuration contract", () => {
	it("keeps only shared verification preferences", () => {
		expect(Object.keys(DEFAULT_CONFIG).sort()).toEqual([
			"expectedPcr0",
			"notifyOnFailure",
			"proofHeaderName",
			"verify",
		]);
	});

	it("pins the audited PCR0 and the SSE proof transport", () => {
		expect(DEFAULT_CONFIG.expectedPcr0).toBe(PUBLISHED_PCR0);
		expect(DEFAULT_CONFIG.proofHeaderName).toBe("x-wokey-tee-proof-mode");
		expect(resolveConfig().expectedPcr0).toBe(PUBLISHED_PCR0);
	});

	it("drops the legacy apiKey and route/trust overrides instead of migrating them", () => {
		writeFileSync(
			file,
			JSON.stringify({
				apiKey: "k",
				baseUrl: "https://evil.example/v1",
				api: "openai-completions",
				expectedHost: "evil.example",
				expectedHosts: ["evil.example"],
				expectedPaths: ["/evil"],
				codexEnvelope: false,
				verify: false,
			}),
		);
		// Legacy keys are dropped on read; preferences survive. The leftover
		// apiKey is never used as a credential — it is only detected so the
		// status panel can tell the user to re-enter it via `/login wokey`.
		expect(loadSettings()).toEqual({ verify: false });
		expect(hasLegacyApiKey()).toBe(true);
		const cfg = resolveConfig();
		expect(cfg.verify).toBe(false);
		expect(cfg.expectedPcr0).toBe(PUBLISHED_PCR0);
	});
});
