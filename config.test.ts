/**
 * Key resolution is on the per-request path (`stream.ts` falls back to it), so
 * it must not re-read and re-parse both credential files on every turn. These
 * tests pin the observable contract: a cached key survives an untouched file,
 * and is invalidated the moment the file changes.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadSettings, PUBLISHED_PCR0, resolveApiKey, resolveConfig } from "./config.ts";

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

describe("api key resolution", () => {
	it("returns the key from the settings file", () => {
		writeFileSync(file, JSON.stringify({ apiKey: "file-key" }));
		expect(resolveApiKey()).toBe("file-key");
	});

	it("keeps the resolved key while the file is unchanged", () => {
		const t = Math.floor(Date.now() / 1000) - 100;
		writeFileSync(file, JSON.stringify({ apiKey: "first" }));
		utimesSync(file, t, t);
		expect(resolveApiKey()).toBe("first");

		// Rewrite the contents but keep the exact mtime: only a cache keyed on file
		// metadata can keep serving the old value here.
		writeFileSync(file, JSON.stringify({ apiKey: "second" }));
		utimesSync(file, t, t);
		expect(resolveApiKey()).toBe("first");
	});

	it("invalidates the cache as soon as the file changes", async () => {
		writeFileSync(file, JSON.stringify({ apiKey: "first" }));
		expect(resolveApiKey()).toBe("first");

		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file, JSON.stringify({ apiKey: "third" }));
		expect(resolveApiKey()).toBe("third");
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

	it("ignores legacy route/trust overrides instead of migrating them", () => {
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
		// Legacy keys are dropped on read; preferences survive.
		expect(loadSettings()).toEqual({ apiKey: "k", verify: false });
		const cfg = resolveConfig();
		expect(cfg.verify).toBe(false);
		expect(cfg.expectedPcr0).toBe(PUBLISHED_PCR0);
	});
});
