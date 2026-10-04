/**
 * The /wokey interactive panels, plus renderStatus's fold behaviour. The pure
 * text builder for Models is covered elsewhere; here we drive the real
 * custom-component factories without a terminal to pin the panel wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type WokeyConfig } from "./config.ts";
import { allSpecs } from "./models.ts";
import { renderStatus, runMenu, type MenuDeps, type MenuStats } from "./tui.ts";
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
		stats: () => ({ verified: 3, gapped: 1, failed: 0, unproven: 0 }),
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
		expect(text).toContain("key");
		expect(text).toContain("enter/esc close · m more");
		expect(text).not.toContain("refresh"); // no manual key: open auto-refreshes
	});

	it("folds the trust anchors away until 'm' is pressed", async () => {
		const panel = await mount(["status"]);
		const collapsed = panel.render(100).join("\n");
		for (const row of ["pinned", "upstream", "probing", "settings"]) expect(collapsed).not.toContain(row);

		panel.handleInput("m");
		const expanded = panel.render(100).join("\n");
		for (const row of ["pinned", "upstream", "probing", "settings"]) expect(expanded).toContain(row);
		expect(expanded).toContain("chatgpt.com");
		expect(expanded).toContain("m less");
	});

	it("folds back on a second 'm' and re-renders each time", async () => {
		const panel = await mount(["status"]);
		const collapsed = panel.render(100).join("\n");
		panel.handleInput("m");
		panel.handleInput("m");
		expect(panel.render(100).join("\n")).toBe(collapsed);
	});

	it("accepts an uppercase 'M' too", async () => {
		const panel = await mount(["status"]);
		panel.handleInput("M");
		expect(panel.render(100).join("\n")).toContain("pinned");
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

	it("auto-refreshes the balance on open and offers no manual refresh key", async () => {
		const refresh = vi.fn(async () => {});
		const syncBalance = vi.fn(async () => {});
		const panel = await mount(["status"], deps({ refresh, syncBalance }));
		// Entering status re-reads the balance once, on mount.
		expect(syncBalance).toHaveBeenCalledOnce();
		// There is no `r` anymore: pressing it refreshes nothing.
		panel.handleInput("r");
		panel.handleInput("R");
		expect(syncBalance).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
		expect(panel.render(100).join("\n")).not.toContain("refresh");
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
	const stats: MenuStats = { verified: 3, gapped: 1, failed: 0, unproven: 0 };
	const LAST: ProofReport = {
		status: "verified",
		checks: [{ name: "Upstream host", ok: true, detail: "signed upstream = chatgpt.com" }],
		upstreamHost: "chatgpt.com",
		upstreamPath: "/backend-api/codex/responses",
		upstreamMethod: "POST",
		reportedModel: "gpt-6-luna",
		bytes: 2048,
		durationMs: 812,
	} as ProofReport;

	it("keeps counters, balance, key and the last exchange when collapsed", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE });
		expect(text).toContain("$10.79");
		// Pin the whole pi-managed auth row, not a substring that also
		// matches "wokey" ("key" alone passes vacuously via "/login wokey").
		expect(text).toContain("auth      pi-managed — /login wokey");
		expect(text).not.toContain("WOKEY_API_KEY");
		expect(text).toContain("chatgpt.com");
		expect(text).toContain("Upstream host");
	});

	it("hides the four trust rows when collapsed", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE });
		expect(text).not.toContain("pinned");
		expect(text).not.toContain("upstream  ");
		expect(text).not.toContain("probing");
		expect(text).not.toContain("settings");
	});

	it("shows the trust rows for every route, verified or not", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE, expanded: true });
		expect(text).toContain("pinned");
		expect(text).toMatch(/upstream\s+chatgpt\.com/);
		expect(text).toMatch(/upstream\s+api\.anthropic\.com/);
		expect(text).toContain("/v1/messages");
		// The chat route pins no upstream: the panel says so instead of blanking.
		expect(text).toMatch(/upstream\s+unverified by design.*openai-chat/);
		expect(text).toContain("probing");
		expect(text).toContain("settings");
	});

	it("defaults to collapsed when no options are passed, so old callers still compile", () => {
		const text = renderStatus(config, stats, LAST);
		expect(text).not.toContain("pinned");
		expect(text).toContain("balance");
	});

	it("shows the last signed endpoint tuple with its method", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE });
		expect(text).toMatch(/chatgpt\.com.*\/backend-api\/codex\/responses.*POST/);
	});

	it("points at pi-managed auth instead of a duplicate key store", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE });
		expect(text).toContain("/login wokey");
		expect(text).not.toMatch(/wokey\.json.*(saved|mirrored|write)/i);
	});

	it("warns when a legacy wokey.json key must be re-entered", () => {
		const text = renderStatus(config, stats, LAST, { balance: BALANCE, legacyKey: true });
		expect(text).toContain("/login wokey");
		expect(text).toMatch(/re-?enter/i);
		expect(renderStatus(config, stats, LAST, { balance: BALANCE, legacyKey: false })).not.toMatch(/re-?enter/i);
	});

	it("surfaces catalog overlay warnings in the status", () => {
		const warning = "catalog: gpt-6-luna not listed upstream — keeping baked-in values";
		const text = renderStatus(config, stats, LAST, { balance: BALANCE, warnings: [warning] });
		expect(text).toContain(warning);
		expect(renderStatus(config, stats, LAST, { balance: BALANCE, warnings: [] })).not.toContain(warning);
	});

	it("is a strict superset when expanded — nothing else moves or disappears", () => {
		const collapsed = renderStatus(config, stats, LAST, { balance: BALANCE }).split("\n");
		const expanded = renderStatus(config, stats, LAST, { balance: BALANCE, expanded: true }).split("\n");
		for (const line of collapsed) expect(expanded.join("\n")).toContain(line);
		// pinned + three route upstreams + probing + settings
		expect(expanded.length).toBe(collapsed.length + 6);
	});

	it("shows a dash, never a blank or NaN, when the balance is unknown", () => {
		expect(renderStatus(config, stats, LAST)).toMatch(/balance\s+—/);
		expect(renderStatus(config, stats, LAST, { balance: undefined })).toMatch(/balance\s+—/);
	});

	it("surfaces a reservation next to the available amount when one is held", () => {
		const text = renderStatus(config, stats, LAST, { balance: { availableUsd: 5, reservedUsd: 1.5 } });
		expect(text).toContain("$5.00");
		expect(text).toContain("$1.50 reserved");
	});

	it("omits the reservation when nothing is held", () => {
		expect(renderStatus(config, stats, LAST, { balance: BALANCE })).not.toContain("reserved");
	});

	it("still renders with no exchange yet and no balance", () => {
		const text = renderStatus(config, stats, undefined);
		expect(text).toContain("No response verified yet this session.");
		expect(text).toMatch(/balance\s+—/);
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
