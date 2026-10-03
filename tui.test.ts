/**
 * The /wokey interactive panels. The pure text builders (renderStatus /
 * renderModels) are covered elsewhere; here we drive the custom-component
 * factories without a real terminal to pin the panel wiring.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.ts";
import { runMenu, type MenuDeps } from "./tui.ts";

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
		refresh: async () => {},
		...over,
	};
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

/** Run a subcommand and render the panel it opened. */
async function renderPanel(argv: string[], menuDeps = deps(), width = 100): Promise<string[]> {
	const { ctx, factory } = fakeCtx();
	await runMenu(menuDeps, argv, ctx as never);
	const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => { render(w: number): string[] };
	return make(tui, theme, {}, () => {}).render(width);
}

describe("/wokey in-TUI panels", () => {
	it("renders Status as a panel with rule, title, anchors and footer", async () => {
		const lines = await renderPanel(["status"]);
		const text = lines.join("\n");
		expect(lines[0]).toMatch(/^─+$/);
		expect(lines[1]).toContain("wokey.ai · status");
		expect(text).toContain("pinned");
		expect(text).toContain("upstream");
		expect(text).toContain("chatgpt.com");
		expect(text).toContain("enter/esc close · r refresh now");
	});

	it("renders Models as a panel listing the active lineup", async () => {
		const text = (await renderPanel(["models"])).join("\n");
		for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) expect(text).toContain(id);
		expect(text).toContain("enter/esc close");
		expect(text).not.toContain("r refresh now"); // models has no refresh action
	});

	it("runs the refresh action on 'r' in the Status panel", async () => {
		const refresh = vi.fn(async () => {});
		const { ctx, factory } = fakeCtx();
		await runMenu(deps({ refresh }), ["status"], ctx as never);
		const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => { handleInput(d: string): void };
		make(tui, theme, {}, () => {}).handleInput("r");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("closes the panel on enter/escape", async () => {
		const done = vi.fn();
		const { ctx, factory } = fakeCtx();
		await runMenu(deps(), ["models"], ctx as never);
		const make = factory() as (t: unknown, th: unknown, kb: unknown, done: (v?: unknown) => void) => { handleInput(d: string): void };
		make(tui, theme, {}, done).handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});
});
