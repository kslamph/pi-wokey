/**
 * How a proof verdict reaches the user. The verdict used to be written straight
 * to stderr in every mode, so in the TUI it landed as raw text on top of the
 * editor, and `ui.notify` was hardcoded to "info" — the dim, coalescing grey
 * status line, never the yellow session warning. These tests pin the routing:
 * styled notification in the TUI, stderr only where there is no dialog-capable
 * UI to draw in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { streamSimple } = vi.hoisted(() => ({ streamSimple: vi.fn((..._args: unknown[]) => ({}) as never) }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ getApiProvider: () => ({ streamSimple }) }));

import wokeyProvider from "./index.ts";
import { resolveConfig, type WokeyConfig } from "./config.ts";
import type { ProofReport, ProofStatus } from "./verify/probe.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Stats = { verified: number; gapped: number; failed: number; unproven: number };
type RunMode = ExtensionContext["mode"];

interface Harness {
	report(report: ProofReport): void;
	notify: ReturnType<typeof vi.fn>;
	stderr: string[];
	stats(): Stats;
	/** Drop the stderr spy; `afterEach` would do it, but tests read better closing their own. */
	restore(): void;
}

function verdict(status: ProofStatus, detail = "received bytes do not match the signed hash"): ProofReport {
	return {
		status,
		checks: status === "verified" ? [{ name: "Response signature", ok: true, detail: "" }] : [{ name: "Response signature", ok: false, detail }],
		upstreamHost: "chatgpt.com",
		upstreamPath: "/backend-api/codex/responses",
		reportedModel: "gpt-6-luna",
		bytes: 1234,
		finishedAt: 1,
		durationMs: 42,
	};
}

function harness(mode: RunMode = "tui", config?: Partial<WokeyConfig>): Harness {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const notify = vi.fn();
	const stderr: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	});
	const pi = {
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		registerCommand: vi.fn(),
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
	};
	wokeyProvider(pi as never, { ...resolveConfig(), verify: true, notifyOnFailure: true, ...config });
	// The native session-start path refreshes the catalog through pi's model
	// registry; the harness stands in a resolving registry here.
	const modelRegistry = { refresh: vi.fn(() => Promise.resolve()), getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)) };
	for (const fn of handlers.get("session_start") ?? []) fn({}, { mode, hasUI: mode !== "print", ui: { notify }, modelRegistry });
	// The startup "ready" notice is informational; keep it out of the assertions.
	notify.mockClear();
	const exposed = (pi as unknown as { __wokey: { report(r: ProofReport): void; stats(): Stats } }).__wokey;
	return {
		report: (r) => exposed.report(r),
		stats: () => exposed.stats(),
		notify,
		stderr,
		restore: () => spy.mockRestore(),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("proof verdict routing", () => {
	it("shows a failed check as a warning-level session message in the TUI", () => {
		const h = harness("tui");
		h.report(verdict("failed"));
		expect(h.notify).toHaveBeenCalledTimes(1);
		const [message, level] = h.notify.mock.calls[0] as [string, string];
		expect(level).toBe("warning");
		expect(message).toContain("verification failed");
		expect(message).toContain("Response signature");
		h.restore();
	});

	it("keeps the raw stderr line out of the TUI, where it overwrites the editor", () => {
		const h = harness("tui");
		h.report(verdict("failed"));
		expect(h.stderr).toEqual([]);
		h.restore();
	});

	it("still writes the verdict to stderr in print mode, where ui.notify is a no-op", () => {
		const h = harness("print");
		h.report(verdict("failed"));
		expect(h.stderr.join("")).toContain("[wokey]");
		expect(h.stderr.join("")).toContain("verification failed");
		h.restore();
	});

	it("stays silent for verified and verified-with-gaps", () => {
		const h = harness("tui");
		h.report(verdict("verified"));
		h.report(verdict("verified-with-gaps"));
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.stats()).toMatchObject({ verified: 1, gapped: 1, failed: 0, unproven: 0 });
		h.restore();
	});

	it("warns once per session for unproven, but every time for failed", () => {
		const h = harness("tui");
		h.report(verdict("unproven", "no tee.proof in the response"));
		h.report(verdict("unproven", "no tee.proof in the response"));
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect((h.notify.mock.calls[0] as [string, string])[1]).toBe("warning");
		h.report(verdict("failed"));
		h.report(verdict("failed"));
		expect(h.notify).toHaveBeenCalledTimes(3);
		h.restore();
	});

	it("stays silent when notifyOnFailure is off", () => {
		const h = harness("tui", { notifyOnFailure: false });
		h.report(verdict("failed"));
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.stderr).toEqual([]);
		h.restore();
	});
});