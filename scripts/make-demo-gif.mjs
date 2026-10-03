/**
 * Generate the README demo GIF for the /wokey TUI.
 *
 * This drives the **real** `runMenu` / `selectOne` / `infoPanel` code from
 * ../tui.ts with a capturing `ctx.ui.custom`, a theme that emits truecolor ANSI,
 * and synthetic ProofReports (a clean verified exchange, then a failed one). The
 * rendered lines are converted to PNGs with ImageMagick's pango coder and
 * assembled into an animated GIF.
 *
 * Requirements: ImageMagick with the PANGO delegate (`magick`), a monospace font.
 * Usage: node scripts/make-demo-gif.mjs
 * Output: docs/wokey-demo.gif
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// ── clean, non-personal demo environment ──────────────────────────────────────
// The status panel prints the settings path and a masked key; point both at a
// throwaway file so the demo shows `.pi/agent/wokey.json`, not a real home dir.
const SANDBOX = mkdtempSync(join(tmpdir(), "wokey-demo-"));
process.chdir(SANDBOX);
mkdirSync(join(SANDBOX, ".pi", "agent"), { recursive: true });
writeFileSync(join(SANDBOX, ".pi", "agent", "wokey.json"), JSON.stringify({ apiKey: "sk-wokey-demo-0123456789abcdef" }));
process.env.WOKEY_CONFIG = ".pi/agent/wokey.json";

const { runMenu } = await import(`${ROOT}/tui.ts`);
const { resolveConfig } = await import(`${ROOT}/config.ts`);

// Raw terminal key sequences, as `handleInput` receives them from pi.
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };

const WIDTH = 104;
const FONT = "JetBrainsMono Nerd Font";
const FONT_SIZE = 13000; // pango units (thousandths of a point)
const BG = "#0d1117";
const CANVAS = "1088x600";

// ── theme: emit truecolor ANSI so the real components render as they do in pi ──
const COLORS = {
	accent: "121;192;255",
	text: "201;209;217",
	muted: "139;148;158",
	success: "63;185;80",
	error: "248;81;73",
	warning: "210;153;34",
};
const theme = {
	fg: (token, text) => `\x1b[38;2;${COLORS[token] ?? COLORS.text}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const tui = { requestRender() {} };

// ── ANSI (SGR) -> pango markup ─────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function lineToMarkup(line) {
	const re = /\x1b\[([0-9;]*)m/g;
	let last = 0;
	let fg = "#c9d1d9";
	let bold = false;
	let out = "";
	const run = (text) => {
		if (!text) return;
		const attrs = `foreground="${fg}"${bold ? ' font_weight="bold"' : ""}`;
		out += `<span ${attrs}>${esc(text)}</span>`;
	};
	for (const match of line.matchAll(re)) {
		run(line.slice(last, match.index));
		last = match.index + match[0].length;
		const codes = match[1].split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) { fg = "#c9d1d9"; bold = false; }
			else if (c === 1) bold = true;
			else if (c === 22) bold = false;
			else if (c === 39) fg = "#c9d1d9";
			else if (c === 38 && codes[i + 1] === 2) {
				fg = `#${[codes[i + 2], codes[i + 3], codes[i + 4]].map((v) => Math.max(0, Math.min(255, Number(v) || 0)).toString(16).padStart(2, "0")).join("")}`;
				i += 4;
			}
		}
	}
	run(line.slice(last));
	return out;
}
const frameMarkup = (lines) =>
	`<span font_family="${FONT}" font_size="${FONT_SIZE}">${lines.map(lineToMarkup).join("&#10;")}</span>`;

// ── synthetic but realistic ProofReports ───────────────────────────────────────
const checks = (signatureOk) => [
	{ name: "Remote attestation", ok: true, detail: "COSE/P-384 chains to the AWS Nitro root" },
	{ name: "Certificate validity", ok: true, detail: "attestation certificate in date" },
	{ name: "Enclave image (PCR0)", ok: true, detail: "matches the pinned audited image" },
	{ name: "Signing key binding", ok: true, detail: "response signer is the attested enclave" },
	{ name: "Nonce binding", ok: true, detail: "proof nonce matches the attestation" },
	{ name: "Upstream host", ok: true, detail: "signed upstream = chatgpt.com" },
	{
		name: "Response signature",
		ok: signatureOk,
		detail: signatureOk ? "signature verifies and response bytes are unaltered" : "received bytes do not match the signed hash — response was modified",
	},
	{ name: "Upstream path", ok: true, detail: "/backend-api/codex/responses" },
	{ name: "Served model", ok: true, detail: "gpt-6-luna" },
];
const report = (signatureOk) => ({
	status: signatureOk ? "verified" : "failed",
	checks: checks(signatureOk),
	upstreamHost: "chatgpt.com",
	upstreamPath: "/backend-api/codex/responses",
	pcr0: "437cbab8c2e5dd11a35ae5b062fe115623a013910b7c26b333e2b3af477944d630fb1dcd76fa9a9b1eefdf1d1021dec2",
	reportedModel: "gpt-6-luna",
	bytes: 2048,
	finishedAt: Date.now(),
	durationMs: 812,
});
function deps(signatureOk) {
	const r = report(signatureOk);
	return {
		config: () => resolveConfig(),
		stats: () => ({ verified: 12, gapped: 1, failed: signatureOk ? 0 : 1, unproven: 0 }),
		last: () => r,
		refresh: async () => {},
	};
}

// ── drive runMenu to get real component instances ──────────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));
function harness() {
	let pending = null;
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory) {
				return new Promise((res) => { pending = { factory, res }; });
			},
			notify() {},
			input: async () => "",
			confirm: async () => false,
			select: async () => undefined,
		},
	};
	return {
		ctx,
		async next() {
			for (let i = 0; i < 50 && !pending; i++) await tick();
			if (!pending) throw new Error("no pending custom component");
			const c = pending;
			pending = null;
			return c.factory(tui, theme, {}, (v) => c.res(v));
		},
	};
}
const render = (component) => component.render(WIDTH);

const frames = [];
const push = (lines, delay) => frames.push({ lines, delay });

// Act 1 — a clean walkthrough ending in a verified exchange.
{
	const h = harness();
	void runMenu(deps(true), [], h.ctx);
	const menu = await h.next();
	push(render(menu), 900);
	menu.handleInput(KEYS.down);
	push(render(menu), 500);
	menu.handleInput(KEYS.enter);
	const models = await h.next();
	push(render(models), 1700);
	models.handleInput(KEYS.escape);
	const menu2 = await h.next();
	push(render(menu2), 500);
	menu2.handleInput(KEYS.up);
	push(render(menu2), 500);
	menu2.handleInput(KEYS.enter);
	const verified = await h.next();
	push(render(verified), 2400);
}
// Act 2 — the same panel after a failed verification.
{
	const h = harness();
	void runMenu(deps(false), [], h.ctx);
	const menu = await h.next();
	push(render(menu), 500);
	menu.handleInput(KEYS.enter);
	const failed = await h.next();
	push(render(failed), 2800);
}

// ── render frames and assemble the GIF ─────────────────────────────────────────
const outDir = join(ROOT, "docs");
mkdirSync(outDir, { recursive: true });
const pngs = [];
frames.forEach((frame, i) => {
	const png = join(SANDBOX, `frame-${String(i).padStart(3, "0")}.png`);
	const markup = frameMarkup(frame.lines);
	try {
		execFileSync("magick", [`pango:${markup}`, "-background", BG, "-gravity", "center", "-extent", CANVAS, png]);
	} catch (error) {
		console.error(`frame ${i} failed. markup:\n${markup.slice(0, 1500)}`);
		console.error(String(error.stderr ?? error.message));
		throw error;
	}
	pngs.push(png);
});
const gif = join(outDir, "wokey-demo.gif");
const args = ["-dispose", "None"];
frames.forEach((frame, i) => args.push("-delay", String(Math.round(frame.delay / 10)), pngs[i]));
args.push("-loop", "0", "-layers", "Optimize", gif);
execFileSync("magick", args);

rmSync(SANDBOX, { recursive: true, force: true });
const { statSync } = await import("node:fs");
console.log(`wrote ${gif} (${frames.length} frames, ${(statSync(gif).size / 1024).toFixed(0)} KiB)`);
