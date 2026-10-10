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
vi.mock("@earendil-works/pi-ai/compat", () => ({
	getApiProvider: () => ({ streamSimple }),
	// provider.ts builds the native provider through these factories; the tests below
	// never stream, so sharing the hoisted streamSimple fake is enough to construct it.
	openAIResponsesApi: () => ({ streamSimple }),
	anthropicMessagesApi: () => ({ streamSimple }),
	openAICompletionsApi: () => ({ streamSimple }),
}));

import wokeyProvider from "./index.ts";
import { resolveConfig, type WokeyConfig } from "./config.ts";
import type { ProofReport, ProofStatus } from "./verify/probe.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Stats = { attested: number; errors: number; unverifiable: number; total: number };
type RunMode = ExtensionContext["mode"];

interface Harness {
	report(report: ProofReport): void;
	notify: ReturnType<typeof vi.fn>;
	stderr: string[];
	stats(): Stats;
	/** Newest-first error log; only real failures should ever land here. */
	errors(): ProofReport[];
	/** Drop the stderr spy; `afterEach` would do it, but tests read better closing their own. */
	restore(): void;
}

function verdict(status: ProofStatus, detail = "received bytes do not match the signed hash", routeId: ProofReport["routeId"] = "openai-codex"): ProofReport {
	return {
		routeId,
		status,
		checks:
			status === "verified"
				? [{ name: "Response signature", ok: true, severity: "pass", detail: "" }]
				: [{ name: "Response signature", ok: false, severity: "fail", detail }],
		upstreamHost: "chatgpt.com",
		upstreamPath: "/backend-api/codex/responses",
		reportedModel: "gpt-6-luna",
		bytes: 1234,
		finishedAt: 1,
		durationMs: 42,
	};
}

/** The documented request-binding gap: not a failure, and never an error card. */
function gapped(): ProofReport {
	return {
		...verdict("verified-with-gaps"),
		checks: [{ name: "Request binding", ok: false, severity: "gap", detail: "request body is rewritten by the relay — not checkable (documented gap)" }],
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
	const exposed = (pi as unknown as { __wokey: { report(r: ProofReport): void; stats(): Stats; errors(): ProofReport[] } }).__wokey;
	return {
		report: (r) => exposed.report(r),
		stats: () => exposed.stats(),
		errors: () => exposed.errors(),
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

	it("treats the documented request-binding gap as attested, not as an error", () => {
		const h = harness("tui");
		h.report(verdict("verified"));
		h.report(gapped());
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.stats()).toEqual({ attested: 2, errors: 0, unverifiable: 0, total: 2 });
		// The gap is disclosed, not hidden — and it is never an error card.
		expect(h.errors()).toEqual([]);
		h.restore();
	});

	it("treats a missing proof on an official route as an error, every time", () => {
		const h = harness("tui");
		h.report(verdict("unproven", "no tee.proof in the response"));
		h.report(verdict("unproven", "no tee.proof in the response"));
		// Proofs stopping is a regression of the claim, not a per-session novelty, so
		// it is no longer deduped the way an ambiguous `unproven` used to be.
		expect(h.notify).toHaveBeenCalledTimes(2);
		expect((h.notify.mock.calls[0] as [string, string])[1]).toBe("warning");
		expect(h.stats()).toMatchObject({ errors: 2 });
		expect(h.errors()).toHaveLength(2);
		h.restore();
	});

	it("keeps the error log newest-first and only holds real failures", () => {
		const h = harness("tui");
		h.report(gapped());
		const first = verdict("failed", "response was modified");
		first.finishedAt = 100;
		const second = verdict("failed", "nonce did not match");
		second.finishedAt = 200;
		h.report(first);
		h.report(second);
		expect(h.errors().map((r) => r.finishedAt)).toEqual([200, 100]);
		h.restore();
	});

	it("stays silent when notifyOnFailure is off, but still logs the error", () => {
		const h = harness("tui", { notifyOnFailure: false });
		h.report(verdict("failed"));
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.stderr).toEqual([]);
		expect(h.errors()).toHaveLength(1);
		h.restore();
	});

	it("never warns for unverified chat-completions routes, and never counts them attested", () => {
		const h = harness("tui");
		h.report(verdict("unproven", "verification covers Claude + GPT routes only", "openai-chat"));
		h.report(verdict("unproven", "verification covers Claude + GPT routes only", "openai-chat"));
		expect(h.notify).not.toHaveBeenCalled();
		expect(h.stderr).toEqual([]);
		// Unverifiable, not verified: inflating the green count with exchanges that
		// carry no attestation at all is the one thing this panel must never do.
		expect(h.stats()).toEqual({ attested: 0, errors: 0, unverifiable: 2, total: 2 });
		expect(h.errors()).toEqual([]);
		h.restore();
	});

	it("keeps every exchange in exactly one bucket", () => {
		const h = harness("tui");
		h.report(verdict("verified"));
		h.report(gapped());
		h.report(verdict("failed"));
		h.report(verdict("unproven", "no tee.proof in the response"));
		h.report(verdict("unproven", "verification covers Claude + GPT routes only", "openai-chat"));
		const s = h.stats();
		expect(s.attested + s.errors + s.unverifiable).toBe(s.total);
		expect(s.total).toBe(5);
		h.restore();
	});
});