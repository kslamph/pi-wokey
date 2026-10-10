/**
 * The /wokey interactive panels, plus renderStatus's attention-only contract.
 * The pure text builder for Models is covered elsewhere; here we drive the real
 * custom-component factories without a terminal to pin the panel wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type WokeyConfig } from "./config.ts";
import { allSpecs } from "./models.ts";
import { renderStatus, runMenu, PAGE_SIZE, statusFooter, type MenuDeps, type StatusOptions } from "./tui.ts";
import type { ProofReport } from "./verify/probe.ts";

const BALANCE = { availableUsd: 10.787384, reservedUsd: 0 };

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const tui = { requestRender: vi.fn() } as never;

function deps(over: Partial<MenuDeps> = {}): MenuDeps {
	return {
		config: () => resolveConfig(),
		errors: () => [],
		last: () => undefined,
		warnings: () => [],
		refresh: async () => {},
		balance: () => BALANCE,
		syncBalance: async () => {},
		allModels: () => allSpecs(),
		enabledModels: () => new Set(["gpt-6-luna"]),
		saveModels: async () => {},
		...over,
	};
}

/** An error report of the shape the probe produces for a blocking-check failure. */
function errorReport(detail: string, at = Date.UTC(2026, 0, 1, 14, 32, 7)): ProofReport {
	return {
		routeId: "openai-codex",
		status: "failed",
		checks: [{ name: "Response signature", ok: false, severity: "fail", detail }],
		upstreamHost: "chatgpt.com",
		upstreamPath: "/backend-api/codex/responses",
		upstreamMethod: "POST",
		reportedModel: "gpt-6.1-sol",
		bytes: 241371,
		finishedAt: at,
		durationMs: 18859,
	} as ProofReport;
}

interface Panel {
	render(w: number): string[];
	handleInput(d: string): void;
}

/** A UI-capable context that records the ctx.ui.custom factory it was given. */
function fakeCtx(): { ctx: unknown; factory: () => unknown } {
	let factory: ((...args: unknown[]) => unknown) | undefined;
	return {
		ctx: {
			hasUI: true,
			ui: {
				custom: (f: (...args: unknown[]) => unknown) => {
					factory = f;
					return Promise.resolve();
				},
				select: async () => undefined,
				notify: () => {},
				input: async () => "",
				confirm: async () => false,
			},
		},
		factory: () => {
			if (!factory) throw new Error("ctx.ui.custom was never called");
			return factory;
		},
	};
}

/** Mount the panel a subcommand opens, so input can be driven too. */
async function mount(argv: string[], menuDeps = deps()): Promise<Panel> {
	const { ctx, factory } = fakeCtx();
	await runMenu(menuDeps, argv, ctx as never);
	const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => Panel;
	return make(tui, theme, {}, () => {});
}

/** Run a subcommand and render the panel it opened. */
async function renderPanel(argv: string[], menuDeps = deps(), width = 100): Promise<string[]> {
	return (await mount(argv, menuDeps)).render(width);
}

describe("/wokey in-TUI panels", () => {
	it("renders Status as a panel with rule, title, footer and the always-visible rows", async () => {
		const lines = await renderPanel(["status"]);
		const text = lines.join("\n");
		expect(lines[0]).toMatch(/^─+$/);
		expect(lines[1]).toContain("wokey.ai · status");
		expect(text).toContain("balance");
		expect(text).toContain("$10.79");
		expect(text).toContain("no exchange yet this session");
		expect(text).toContain("enter/esc close");
		expect(text).not.toContain("refresh"); // no manual key: open auto-refreshes
	});

	it("advertises no paging keys until the error log overflows a page", () => {
		expect(statusFooter(0)).toBe("enter/esc close");
		expect(statusFooter(PAGE_SIZE)).toBe("enter/esc close");
		expect(statusFooter(PAGE_SIZE + 1)).toBe("enter/esc close · ↑/↓ error · pgup/pgdn");
	});

	it("has no fold key, because there is no static detail left to disclose", async () => {
		const text = (await renderPanel(["status"])).join("\n");
		expect(text).not.toContain("m more");
		expect(text).not.toContain("m less");
		// Nothing on the panel is the same on every open.
		for (const row of ["pinned", "upstream", "probing", "settings", "/login wokey", "acknowledged limits"]) {
			expect(text).not.toContain(row);
		}
	});

	it("renders the panel identically whatever keys are pressed, since there is no fold", async () => {
		const panel = await mount(["status"]);
		const before = panel.render(100).join("\n");
		panel.handleInput("m");
		panel.handleInput("M");
		expect(panel.render(100).join("\n")).toBe(before);
	});

	it("keeps the models selector free of the fold hint and shows its own keys", async () => {
		const text = (await renderPanel(["models"])).join("\n");
		expect(text).toContain("enter save");
		expect(text).toContain("space toggle");
		expect(text).not.toContain("m more");
	});

	it("reads the balance when the panel opens", async () => {
		const syncBalance = vi.fn(async () => {});
		await renderPanel(["status"], deps({ syncBalance }));
		expect(syncBalance).toHaveBeenCalledOnce();
	});

	it("re-reads the balance and the catalog when the panel opens, with no manual key", async () => {
		const refresh = vi.fn(async () => {});
		const syncBalance = vi.fn(async () => {});
		const panel = await mount(["status"], deps({ refresh, syncBalance }));
		// Entering status re-syncs once, on mount.
		expect(syncBalance).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		// There is no manual key: pressing keys syncs nothing more.
		panel.handleInput("r");
		panel.handleInput("R");
		expect(syncBalance).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		expect(panel.render(100).join("\n")).not.toContain("r refresh");
	});

	it("re-reads the catalog when the models selector opens", async () => {
		const refresh = vi.fn(async () => {});
		await mount(["models"], deps({ refresh }));
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("shows a transient rates hint until the sync lands, then repaints", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const refresh = vi.fn(() => gate);
		const requestRender = (tui as unknown as { requestRender: ReturnType<typeof vi.fn> }).requestRender;
		requestRender.mockClear();
		const panel = await mount(["models"], deps({ refresh }));
		expect(refresh).toHaveBeenCalledOnce();
		expect(panel.render(100).join("\n")).toContain("refreshing live rates…");
		release();
		await gate;
		await new Promise((r) => setTimeout(r, 0));
		expect(requestRender).toHaveBeenCalled();
		expect(panel.render(100).join("\n")).not.toContain("refreshing live rates…");
	});

	it("renders Models as vendor tabs opening on the first vendor's lineup", async () => {
		const text = (await renderPanel(["models"])).join("\n");
		for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) expect(text).toContain(id);
		for (const vendor of ["OpenAI", "Anthropic", "Zhipu", "MiniMax", "DeepSeek"]) expect(text).toContain(vendor);
		// Other vendors wait behind their tabs — one vendor per view.
		expect(text).not.toContain("claude-opus-5-5");
		expect(text).not.toContain("r refresh now"); // models has no refresh action
	});

	it("switches vendor tabs on left/right and marks the checked set", async () => {
		const panel = await mount(["models"]);
		panel.handleInput("\x1b[C"); // → Anthropic
		let text = panel.render(100).join("\n");
		expect(text).toContain("claude-opus-5-5");
		expect(text).not.toContain("gpt-6-luna");
		panel.handleInput("\x1b[C"); // → Zhipu
		panel.handleInput("\x1b[C"); // → MiniMax
		panel.handleInput("\x1b[C"); // → DeepSeek
		text = panel.render(100).join("\n");
		expect(text).toContain("deepseek-v4-flash");
		expect(text).toContain("[unverified]");
		panel.handleInput("\x1b[D"); // ← back to MiniMax
		text = panel.render(100).join("\n");
		expect(text).toContain("MiniMax-M3");
	});

	it("toggles models with space and saves the checked set on enter", async () => {
		const saveModels = vi.fn(async (_ids: string[]) => {});
		const done = vi.fn();
		const { ctx, factory } = fakeCtx();
		await runMenu(deps({ saveModels }), ["models"], ctx as never);
		const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => Panel;
		const panel = make(tui, theme, {}, done);
		// deps() pre-checks gpt-6-luna only: move to it, uncheck it, move to astra, check it.
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		panel.handleInput("\r");
		// saveModels runs before the panel closes.
		await new Promise((r) => setTimeout(r, 0));
		expect(saveModels).toHaveBeenCalledOnce();
		expect(saveModels.mock.calls[0]![0]).toEqual(["gpt-6-astra"]);
		expect(done).toHaveBeenCalledOnce();
	});

	it("cancels on escape without saving", async () => {
		const saveModels = vi.fn(async (_ids: string[]) => {});
		const done = vi.fn();
		const { ctx, factory } = fakeCtx();
		await runMenu(deps({ saveModels }), ["models"], ctx as never);
		const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => Panel;
		const panel = make(tui, theme, {}, done);
		panel.handleInput(" ");
		panel.handleInput("\x1b");
		await new Promise((r) => setTimeout(r, 0));
		expect(saveModels).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalledOnce();
	});
});

describe("renderStatus", () => {
	const config: WokeyConfig = resolveConfig();
	const LAST: ProofReport = {
		status: "verified-with-gaps",
		checks: [
			{ name: "Remote attestation", ok: true, severity: "pass", detail: "" },
			{ name: "Response signature", ok: true, severity: "pass", detail: "" },
			{ name: "Request binding", ok: false, severity: "gap", detail: "request body is rewritten by the relay — not checkable (documented gap)" },
		],
		upstreamHost: "chatgpt.com",
		upstreamPath: "/backend-api/codex/responses",
		upstreamMethod: "POST",
		reportedModel: "gpt-6.1-sol",
		bytes: 241371,
		durationMs: 18859,
		finishedAt: Date.UTC(2026, 0, 1, 14, 32, 7),
	} as ProofReport;

	it("leads with the last exchange and shows no counter row at all", () => {
		const text = renderStatus(config, LAST, { balance: BALANCE });
		// The four-glyph legend read as "31 problems" on a healthy session; the tally
		// it replaced added nothing actionable. Neither is here.
		expect(text).not.toMatch(/✅\s*\d/);
		expect(text).not.toMatch(/🟡|⚠️/);
		expect(text).toContain("no errors this session");
		expect(text).toContain("$10.79");
		expect(text).toContain("chatgpt.com/backend-api/codex/responses POST");
	});

	it("counts an accepted gap as verified, and names the check that did not run", () => {
		const text = renderStatus(config, LAST, { balance: BALANCE });
		expect(text).toContain("verified · 2 of 3 checks · Request binding not checkable");
		// No ✗ anywhere: the request-binding gap is disclosed, never shown as an error.
		expect(text).not.toContain("✗");
	});

	it("distinguishes a check that cannot be checked from one that was not checked", () => {
		const unpinned = {
			...LAST,
			checks: [{ name: "Enclave image (PCR0)", ok: false, severity: "unchecked", detail: "" }],
		} as ProofReport;
		expect(renderStatus(config, unpinned, { balance: BALANCE })).toContain("Enclave image (PCR0) not checked");
		expect(renderStatus(config, LAST, { balance: BALANCE })).toContain("Request binding not checkable");
	});

	it("omits the caveat clause when every check ran", () => {
		const all = { ...LAST, checks: [{ name: "Response signature", ok: true, severity: "pass", detail: "" }] } as ProofReport;
		expect(renderStatus(config, all, { balance: BALANCE })).toContain("verified · 1 of 1 checks");
		expect(renderStatus(config, all, { balance: BALANCE })).not.toContain("not check");
	});

	it("humanizes bytes and latency instead of printing raw numbers", () => {
		const text = renderStatus(config, LAST, { balance: BALANCE });
		expect(text).toContain("241 KB · 18.9 s");
		expect(text).not.toContain("241371 B");
	});

	it("never restates the accepted limits — they are static and already acknowledged", () => {
		const text = renderStatus(config, LAST, { balance: BALANCE });
		expect(text).not.toContain("acknowledged limits");
		expect(text).not.toMatch(/request binding —|chat models —/);
		expect(text).not.toContain("unverified by design");
	});

	it("shows an error card with the reason, the endpoint and the exchange facts", () => {
		const text = renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("received bytes do not match the signed hash — response was modified")] });
		expect(text).toContain("error");
		expect(text).toContain("✗ Response signature — received bytes do not match the signed hash");
		expect(text).toContain("chatgpt.com/backend-api/codex/responses POST");
		expect(text).toContain("gpt-6.1-sol · 241 KB · 18.9 s");
		// An error replaces the last-exchange block rather than duplicating it.
		expect(text).not.toContain("no errors this session");
	});

	it("shows only the error when there is one", () => {
		const text = renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("boom")] });
		expect(text).not.toContain("last ");
		expect(text).not.toContain("no errors");
		expect(text).toContain("error");
	});

	it("says a verifier fault is not a verdict on wokey", () => {
		// The shape createProbingFetch produces when the body cannot be read.
		const fault = {
			...errorReport("the response could not be read for verification"),
			checks: [{ name: "Verifier error", ok: false, severity: "fail", detail: "the response could not be read for verification" }],
			reason: "could not read response for verification",
			bytes: 0,
		} as ProofReport;
		const text = renderStatus(config, undefined, { balance: BALANCE, errors: [fault] });
		expect(text).toContain("✗ Verifier error");
		expect(text).toContain("not a verdict on wokey");
		// It is still an error card, not an accepted limit.
		expect(text).toContain("error");
	});

	it("pages the log and shows a position, not a bare count", () => {
		const errors = Array.from({ length: 5 }, (_, i) => errorReport(`failure ${i}`, Date.UTC(2026, 0, 1, 14, 30 - i)));
		const first = renderStatus(config, undefined, { balance: BALANCE, errors });
		expect(first).toContain("errors 1–3 of 5");
		const second = renderStatus(config, undefined, { balance: BALANCE, errors, cursor: 1 });
		expect(second).toContain("errors 4–5 of 5");
		expect(second).toContain("failure 3");
		expect(second).not.toContain("failure 0");
	});

	it("clamps the cursor at both ends rather than rendering an empty page", () => {
		const errors = Array.from({ length: 5 }, (_, i) => errorReport(`failure ${i}`));
		expect(renderStatus(config, undefined, { balance: BALANCE, errors, cursor: -3 })).toContain("errors 1–3 of 5");
		expect(renderStatus(config, undefined, { balance: BALANCE, errors, cursor: 99 })).toContain("errors 4–5 of 5");
		// A log that shrank below the cursor still shows its only page.
		expect(renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("only")], cursor: 7 })).toContain("only");
	});

	it("pages the log with the arrow and page keys, and never runs off the end", async () => {
		const errors = Array.from({ length: 8 }, (_, i) => errorReport(`failure ${i}`, Date.UTC(2026, 0, 1, 14, 30 - i)));
		const panel = await mount(["status"], deps({ errors: () => errors }));
		const text = (): string => panel.render(100).join("\n");
		expect(text()).toContain("errors 1–3 of 8");
		panel.handleInput("\x1b[B"); // ↓ one card
		expect(text()).toContain("errors 4–6 of 8");
		panel.handleInput("\x1b[6~"); // pageDown → last page
		expect(text()).toContain("errors 7–8 of 8");
		panel.handleInput("\x1b[B"); // ↓ past the end, clamped
		expect(text()).toContain("errors 7–8 of 8");
		panel.handleInput("\x1b[H"); // home
		expect(text()).toContain("errors 1–3 of 8");
		panel.handleInput("\x1b[5~"); // pageUp at the top, clamped
		expect(text()).toContain("errors 1–3 of 8");
		panel.handleInput("\x1b[F"); // end
		expect(text()).toContain("errors 7–8 of 8");
		panel.handleInput("\x1b[5~"); // pageUp back one page
		expect(text()).toContain("errors 4–6 of 8");
	});

	it("ignores paging keys entirely when the log fits one page", async () => {
		const panel = await mount(["status"], deps({ errors: () => [errorReport("only failure")] }));
		panel.handleInput("\x1b[B");
		expect(panel.render(100).join("\n")).toContain("only failure");
		expect(panel.render(100).join("\n")).toContain("enter/esc close");
	});

	it("wraps long reasons and never exceeds the wrap width", () => {
		const text = renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("served ".concat("an-unexpected-model ".repeat(12)))] });
		for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(76);
		// The continuation is visibly part of the same statement.
		expect(text).toMatch(/✗ Response signature — served[\s\S]*an-unexpected-model/);
	});

	it("leaves no trailing whitespace on any line", () => {
		for (const text of [renderStatus(config, LAST, { balance: BALANCE }), renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("boom")] })]) {
			for (const line of text.split("\n")) expect(line).toBe(line.trimEnd());
		}
	});

	it("warns when verification has been switched off, and stays silent when it has not", () => {
		expect(renderStatus(config, LAST, { balance: BALANCE })).not.toContain("verification is OFF");
		expect(renderStatus({ ...config, verify: false }, LAST, { balance: BALANCE })).toContain(
			"verification is OFF — responses are not checked at all",
		);
	});

	it("never renders the static trust anchors or the check roster", () => {
		for (const text of [renderStatus(config, LAST, { balance: BALANCE }), renderStatus(config, undefined, { balance: BALANCE, errors: [errorReport("boom")] })]) {
			for (const row of ["pinned", "upstream ", "probing", "settings ", "/login wokey", "Remote attestation", "Enclave image"]) {
				expect(text).not.toContain(row);
			}
		}
	});

	it("names an unpinned anchor as a configuration weakness, not an exchange error", () => {
		const weak = renderStatus({ ...config, expectedPcr0: "" }, LAST, { balance: BALANCE });
		expect(weak).toContain("verification is weaker than intended");
		expect(weak).toMatch(/no audit PCR0 is pinned/);
		expect(weak).not.toContain("✗");
		// There is no fold to hide behind, so it is always on screen.
		expect(renderStatus(config, LAST, { balance: BALANCE })).not.toContain("verification is weaker");
	});

	it("has retired the fold: a stale `expanded` flag changes nothing", () => {
		// The anchors were identical on every open, so they became documentation.
		// An old caller still passing `expanded` must not resurrect the fold.
		const plain = renderStatus(config, LAST, { balance: BALANCE });
		for (const row of ["pinned", "upstream", "probing", "settings", "last exchange —"]) {
			expect(plain).not.toContain(row);
		}
		const stale = { balance: BALANCE, expanded: true } as unknown as StatusOptions;
		expect(renderStatus(config, LAST, stale)).toBe(plain);
	});

	it("shows a dash, never a blank or NaN, when the balance is unknown", () => {
		expect(renderStatus(config, LAST)).toMatch(/balance\s+—/);
		expect(renderStatus(config, LAST, { balance: undefined })).toMatch(/balance\s+—/);
	});

	it("surfaces a reservation next to the available amount when one is held", () => {
		const text = renderStatus(config, LAST, { balance: { availableUsd: 5, reservedUsd: 1.5 } });
		expect(text).toContain("$5.00");
		expect(text).toContain("$1.50 reserved");
		expect(renderStatus(config, LAST, { balance: BALANCE })).not.toContain("reserved");
	});

	it("does not claim a clean session when nothing has happened yet", () => {
		const text = renderStatus(config, undefined);
		expect(text).toContain("no exchange yet this session");
		expect(text).toMatch(/balance\s+—/);
	});

	it("warns when a legacy wokey.json key must be re-entered", () => {
		expect(renderStatus(config, LAST, { balance: BALANCE, legacyKey: true })).toMatch(/re-?enter/i);
		expect(renderStatus(config, LAST, { balance: BALANCE, legacyKey: false })).not.toMatch(/re-?enter/i);
	});

	it("surfaces catalog overlay warnings in the status", () => {
		const warning = "catalog: gpt-6.1-luna not listed upstream — keeping baked-in values";
		expect(renderStatus(config, LAST, { balance: BALANCE, warnings: [warning] })).toContain(warning);
		expect(renderStatus(config, LAST, { balance: BALANCE, warnings: [] })).not.toContain(warning);
	});
});

describe("/wokey mixed-model lineup", () => {
	it("renders GPT and Claude rows with route/API identity and thinking levels", async () => {
		const panel = await mount(["models"]);
		const gpt = panel.render(100).join("\n");
		for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) expect(gpt).toContain(id);
		expect(gpt).toContain("openai-responses");
		panel.handleInput("\x1b[C"); // → Anthropic
		const claude = panel.render(100).join("\n");
		expect(claude).toContain("claude-opus-5-5");
		expect(claude).toContain("anthropic-messages");
		// Thinking levels come from the picker map, not prose.
		expect(gpt).toMatch(/gpt-6-luna.*off.*low.*medium.*high.*xhigh.*max/);
		expect(claude).toMatch(/claude-opus-5-5.*low.*medium.*high.*xhigh.*max/);
	});

	it("keeps prices and context limits formatted without float dust", async () => {
		const panel = await mount(["models"]);
		const gpt = panel.render(100).join("\n");
		expect(gpt).toMatch(/gpt-6-luna.*\$0\.09.*\$0\.45/);
		expect(gpt).toMatch(/gpt-6-luna.*1\.05M/);
		panel.handleInput("\x1b[C"); // → Anthropic
		const claude = panel.render(100).join("\n");
		expect(claude).toMatch(/claude-opus-5-5.*\$0\.6.*\$3/);
		expect(claude).toMatch(/claude-opus-5-5.*1\.00M/);
		expect(`${gpt}\n${claude}`).not.toMatch(/0\.89999999/);
	});

	it("tags the chat-completions vendors unverified with their own prices", async () => {
		const panel = await mount(["models"]);
		panel.handleInput("\x1b[C"); // → Anthropic
		panel.handleInput("\x1b[C"); // → Zhipu
		const zhipu = panel.render(100).join("\n");
		expect(zhipu).toMatch(/glm-5\.3-flash.*\$0\.075.*\$0\.25/);
		expect(zhipu).toContain("[unverified]");
		panel.handleInput("\x1b[C"); // → MiniMax
		panel.handleInput("\x1b[C"); // → DeepSeek
		const deepseek = panel.render(100).join("\n");
		expect(deepseek).toMatch(/deepseek-v4-flash.*\$0\.112.*\$0\.448/);
		expect(deepseek).toContain("[unverified]");
	});
});

describe("headless renders", () => {
	/** Headless context capturing what `show()` notifies. */
	function headlessCtx() {
		const notes: string[] = [];
		return {
			notes,
			ctx: { hasUI: false, ui: { notify: (text: string) => notes.push(text) } },
		};
	}

	it("syncs the catalog before printing status", async () => {
		const refresh = vi.fn(async () => {});
		const syncBalance = vi.fn(async () => {});
		const { notes, ctx } = headlessCtx();
		await runMenu(deps({ refresh, syncBalance }), ["status"], ctx as never);
		expect(refresh).toHaveBeenCalledOnce();
		expect(syncBalance).toHaveBeenCalledOnce();
		expect(notes.join("\n")).toContain("balance");
	});

	it("syncs the catalog before printing the models table", async () => {
		const refresh = vi.fn(async () => {});
		const { notes, ctx } = headlessCtx();
		await runMenu(deps({ refresh }), ["models"], ctx as never);
		expect(refresh).toHaveBeenCalledOnce();
		expect(notes.join("\n")).toContain("gpt-6-luna");
	});

	it("still prints when the sync fails", async () => {
		const refresh = vi.fn(async () => {
			throw new Error("relay down");
		});
		const { notes, ctx } = headlessCtx();
		await runMenu(deps({ refresh }), ["models"], ctx as never);
		expect(notes.join("\n")).toContain("gpt-6-luna");
	});
});

describe("retired duplicate key commands", () => {
	/** Headless context capturing what `show()` notifies. */
	function headlessCtx() {
		const notes: string[] = [];
		return {
			notes,
			ctx: { hasUI: false, ui: { notify: (text: string) => notes.push(text) } },
		};
	}

	it.each([["key", "sk-new-key"], ["key"], ["unset"], ["clear"]])(
		"guides /wokey %s to pi-managed auth instead of touching wokey.json",
		async (...argv: string[]) => {
			const { notes, ctx } = headlessCtx();
			await runMenu(deps(), argv, ctx as never);
			const text = notes.join("\n");
			expect(text).toMatch(argv[0] === "key" ? /\/login wokey/ : /\/logout wokey/);
			expect(text).not.toMatch(/saved to.*wokey\.json/i);
			expect(text).not.toMatch(/removed from.*wokey\.json/i);
		},
	);
});
