/**
 * Guard the metadata pi.dev and npm search actually read.
 *
 * The pi.dev package catalog builds each card's search text from
 * name + description + author + type + keywords, so keywords are a real
 * discovery surface — and `pi-package` in particular is how the catalog
 * recognises a pi package at all. These assertions are cheap insurance
 * against someone tidying package.json and silently dropping indexing.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
	description?: string;
	keywords?: string[];
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
};

const keywords = pkg.keywords ?? [];

describe("npm metadata used for discovery", () => {
	it("declares the keyword the pi.dev catalog keys off", () => {
		expect(keywords).toContain("pi-package");
	});

	it("uses npm-legal keyword syntax", () => {
		// npm accepts spaces, but they break token search; anything outside
		// [a-z0-9-] is dead weight on every index that reads this field.
		const illegal = keywords.filter((k) => !/^[a-z0-9][a-z0-9-]*$/.test(k));
		expect(illegal).toEqual([]);
	});

	it("has no duplicate keywords", () => {
		expect([...new Set(keywords)]).toEqual(keywords);
	});

	it("covers the terms a user would actually search for", () => {
		for (const term of ["pi", "pi-extension", "provider", "openai", "tee", "attestation", "wokey"]) {
			expect(keywords).toContain(term);
		}
	});

	it("keeps a searchable description that names the service and the mechanism", () => {
		const description = pkg.description ?? "";
		expect(description.length).toBeGreaterThan(40);
		expect(description.length).toBeLessThanOrEqual(512);
		expect(description).toMatch(/wokey/i);
		expect(description).toMatch(/tee|attestation/i);
	});

	it("still declares the pi extension manifest and its peers", () => {
		expect(pkg.pi?.extensions).toEqual(["./index.ts"]);
		expect(Object.keys(pkg.peerDependencies ?? {})).toContain("@earendil-works/pi-coding-agent");
	});
});