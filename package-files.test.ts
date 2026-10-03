/**
 * Guard the publish allowlist in package.json.
 *
 * `files` is an allowlist: anything not listed is silently absent from the npm
 * tarball, and a missing runtime import does not fail the build here — it fails
 * in the user's terminal, as `Cannot find module './tui.ts'`, the first time pi
 * loads the installed extension. Every published version shipped that way,
 * because tui.ts was imported by index.ts but never added to `files`.
 *
 * So walk the real import graph from the extension entrypoint and assert that
 * every module it reaches would actually be in the tarball.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENTRY = "index.ts";

/** npm always ships these regardless of `files`. */
const ALWAYS_SHIPPED = new Set(["package.json", "README.md", "LICENSE", "LICENCE", "NOTICE"]);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files?: string[] };

/** Would `rel` (repo-relative, posix separators) end up in the tarball? */
function isPublished(rel: string): boolean {
	if (ALWAYS_SHIPPED.has(rel)) return true;
	for (const entry of pkg.files ?? []) {
		const clean = entry.replace(/\/+$/, "");
		if (rel === clean || rel.startsWith(`${clean}/`)) return true;
	}
	return false;
}

/** Every relative specifier (`./x.ts`, `../y/z.mjs`) in a source file. */
function localImports(source: string): string[] {
	const found = new Set<string>();
	const re = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
	for (const match of source.matchAll(re)) {
		if (match[1]) found.add(match[1]);
	}
	return [...found];
}

/** Transitively reachable repo files from the extension entrypoint. */
function reachableModules(entry: string): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		if (graph.has(current)) continue;
		const file = join(ROOT, current);
		if (!existsSync(file)) continue;
		const imports = localImports(readFileSync(file, "utf8"))
			.map((spec) => relative(ROOT, resolve(dirname(file), spec)).split("\\").join("/"))
			.filter((rel) => rel.startsWith(".") === false && !rel.startsWith(".."))
			.filter((rel) => existsSync(join(ROOT, rel)));
		graph.set(current, imports);
		queue.push(...imports);
	}
	return graph;
}

describe("published package contents", () => {
	const graph = reachableModules(ENTRY);

	it("finds the extension entrypoint and its module graph", () => {
		expect(existsSync(join(ROOT, ENTRY))).toBe(true);
		expect(graph.size).toBeGreaterThan(1);
		expect(graph.get(ENTRY)).toContain("tui.ts");
	});

	it("ships every module the entrypoint imports", () => {
		const missing: string[] = [];
		for (const [from, imports] of graph) {
			for (const to of imports) {
				if (!isPublished(to)) missing.push(`${from} -> ${to}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("does not list a file that does not exist", () => {
		const stale = (pkg.files ?? []).filter((entry) => !existsSync(join(ROOT, entry)));
		expect(stale).toEqual([]);
	});
});