/**
 * Generate the README demo GIF for the /wokey TUI.
 *
 * This drives the **real** `runMenu` / `selectOne` / `infoPanel` / model-selector
 * code from ../tui.ts with a capturing `ctx.ui.custom`, a theme that emits truecolor
 * ANSI, and synthetic ProofReports (a clean verified exchange, then a failed one).
 * Act 1 walks the menu into the model selector (vendor tabs, an opt-in model toggled
 * on) and into the status panel (trust anchors folded out and back); act 2 shows the
 * same status panel after a failed verification. The rendered lines are converted to
 * PNGs with ImageMagick's pango coder and assembled into an animated GIF.
 *
 * Look: pure monochrome (black canvas, white text, dim grey for everything
 * else, no hue), every frame padded to the same 100xN character grid and
 * rendered at the same NorthWest offset, every frame held for the same 2.5s —
 * so the loop reads as one live terminal session instead of text that resizes
 * and re-centers on each frame.
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
// The expanded status panel prints the settings path, so point it at a throwaway
// file to show `.pi/agent/wokey.json` instead of a real home dir. The file holds
// preferences only — no legacy `apiKey` — so the panel renders its normal state
// (`auth … /login wokey`) rather than the retired-key migration warning.
const SANDBOX = mkdtempSync(join(tmpdir(), "wokey-demo-"));
process.chdir(SANDBOX);
mkdirSync(join(SANDBOX, ".pi", "agent"), { recursive: true });
writeFileSync(join(SANDBOX, ".pi", "agent", "wokey.json"), "{}\n");
process.env.WOKEY_CONFIG = ".pi/agent/wokey.json";

const tuiMod = await import(`${ROOT}/tui.ts`);
const { runMenu, MARK } = tuiMod;
const { resolveConfig } = await import(`${ROOT}/config.ts`);
const { allSpecs, enabledModelIds } = await import(`${ROOT}/models.ts`);

// The TUI's status marks are color emoji, which would break the monochrome
// theme. Swap them for glyphs in the same font as the rest of the text; this
// process is throwaway, so mutating the imported map is safe.
MARK.verified = "\u25cf"; // filled circle
MARK["verified-with-gaps"] = "\u25d0"; // half-filled circle
MARK.failed = "\u2717"; // ballot x
MARK.unproven = "\u25b3"; // hollow triangle

// Raw terminal key sequences, as `handleInput` receives them from pi.
const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	space: " ",
	enter: "\r",
	escape: "\x1b",
	more: "m",
};

// Terminal grid. Every frame renders into the same box at the same offset, so
// the GIF reads as one window whose content changes in place, not as text that
// re-centers and resizes on each frame.
const WIDTH = 112; // columns handed to the components (truncateToWidth)
const FONT = "JetBrainsMono Nerd Font,DejaVu Sans Mono"; // fallback renders ❯, which JetBrains Mono lacks
const FONT_SIZE = 13000; // pango units (thousandths of a point)
const BG = "#000000";
const CANVAS_W = 1168; // 112 cols + 2*PAD_X at 10.00px/col
const CANVAS_H = 720; // 29 rows: the tallest frame is the expanded status panel
const PAD_X = 24;
const PAD_Y = 12;
const FRAME_DELAY_MS = 2500; // every frame holds for the same beat
const NBSP = "\u00a0"; // forces pango to emit a line box for an empty line

// ── theme: emit truecolor ANSI so the real components render as they do in pi ──
// Pure monochrome: white primary, dim grey for everything else, no hue at all.
const WHITE = "255;255;255";
const GREY = "139;139;139";
const COLORS = {
	accent: WHITE,
	text: WHITE,
	muted: GREY,
	success: GREY,
	error: GREY,
	warning: GREY,
};
const theme = {
	fg: (token, text) => `\x1b[38;2;${COLORS[token] ?? COLORS.text}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const tui = { requestRender() {} };

// pango always paints an opaque white page and ignores -background, so every
// frame is rendered on that page in *inverted* colours and then negated:
// white page -> black canvas, inverted grey -> exactly #8b8b8b, inverted
// white (black) -> white glyphs. Antialiasing inverts cleanly, and the result
// is composited at a fixed offset so line 1 never moves between frames.
const invert = (hex) => {
	const n = hex.replace("#", "");
	const [r, g, b] = [0, 2, 4].map((i) => 255 - parseInt(n.slice(i, i + 2), 16));
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

// ── ANSI (SGR) -> pango markup ─────────────────────────────────────────────────
// Escape markup metacharacters. U+276F (❯, the selection pointer) is emitted as
// an entity so run() can split it out of colored runs (see below).
const esc = (s) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/❯/g, "&#x276F;");
// Invert every colour the markup asks for (see `invert` above).
const invertMarkup = (markup) => markup.replace(/foreground="(#[0-9a-f]{6})"/g, (_, hex) => `foreground="${invert(hex)}"`);
function lineToMarkup(line) {
	const re = /\x1b\[([0-9;]*)m/g;
	let last = 0;
	let fg = "#ffffff";
	let bold = false;
	let out = "";
	const POINTER = "&#x276F;"; // see esc(): the ❯ selection pointer as an entity
	const run = (text) => {
		if (!text) return;
		const attrs = `foreground="${fg}"${bold ? ' font_weight="bold"' : ""}`;
		// The pointer takes DejaVu Sans Mono explicitly: JetBrainsMono Nerd Font
		// ships its own ❯ (drawn as ")") and, first in the stack, always wins
		// fallback. DejaVu holds the glyph directly, so no fallback is needed
		// and the nested span renders a real ❯.
		const chunks = esc(text).split(POINTER);
		chunks.forEach((chunk, i) => {
			if (chunk) out += `<span ${attrs}>${chunk}</span>`;
			if (i < chunks.length - 1) out += `<span font_family="DejaVu Sans Mono" ${attrs}>${POINTER}</span>`;
		});
	};
	for (const match of line.matchAll(re)) {
		run(line.slice(last, match.index));
		last = match.index + match[0].length;
		const codes = match[1].split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) { fg = "#ffffff"; bold = false; }
			else if (c === 1) bold = true;
			else if (c === 22) bold = false;
			else if (c === 39) fg = "#ffffff";
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
	`<span font_family="${FONT}" font_size="${FONT_SIZE}">${lines.map((l) => invertMarkup(lineToMarkup(l))).join("&#10;")}</span>`;

// ── fixed grid: calibrate one cell, then size every frame identically ──────────
function measureCell() {
	// One probe line of WIDTH non-breaking spaces gives the column width (an
	// all-nbsp line cannot wrap); ten of them give the line height.
	const probe = Array.from({ length: 10 }, () => NBSP.repeat(WIDTH)).join("&#10;");
	const png = join(SANDBOX, "cell-probe.png");
	execFileSync("magick", [`pango:<span font_family="${FONT}" font_size="${FONT_SIZE}">${probe}</span>`, "-background", BG, png]);
	const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", png]).toString().trim().split(/\s+/).map(Number);
	return { charW: w / WIDTH, lineH: h / 10 };
}
const cell = measureCell();
const ROWS = Math.floor((CANVAS_H - 2 * PAD_Y) / cell.lineH);
const colsThatFit = Math.floor((CANVAS_W - 2 * PAD_X) / cell.charW);
if (colsThatFit < WIDTH) throw new Error(`grid too wide: ${WIDTH} cols need more than ${CANVAS_W - 2 * PAD_X}px at ${cell.charW.toFixed(2)}px/col`);
console.log(`grid ${WIDTH}x${ROWS} (cell ${cell.charW.toFixed(2)}x${cell.lineH.toFixed(2)}px, ${colsThatFit} cols fit)`);

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
		warnings: () => [],
		refresh: async () => {},
		// The demo must not touch the real account, so the balance is synthetic
		// and the fetch is a no-op — the panel code path is still the real one.
		balance: () => ({ availableUsd: 24.5, reservedUsd: 0 }),
		syncBalance: async () => {},
		// Real rows and the real default lineup, so the selector frames show the
		// models, rates, tabs and checked set a user would see. Toggling is live;
		// saving is a no-op so the demo never writes a settings file.
		allModels: () => allSpecs(),
		enabledModels: () => enabledModelIds(),
		saveModels: async () => {},
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

// Every frame is padded to the same ROWS-line block, so the rendered text box
// is byte-identical in geometry across the whole animation.
const frames = [];
const push = (lines, delay = FRAME_DELAY_MS) => {
	// Fail loudly rather than clip: a silently cut-off panel in the README
	// would misrepresent what the status view actually shows.
	if (lines.length > ROWS) throw new Error(`frame overflows the grid: ${lines.length} > ${ROWS} lines — raise CANVAS_H`);
	const block = lines.slice(0, ROWS);
	while (block.length < ROWS) block.push("");
	frames.push({ lines: block, delay });
};

// Act 1 — menu → model selector → status: the selector shows the real lineup,
// vendor switching, an opt-in model toggled on; the status panel shows a verified
// exchange with the trust anchors folded out via `m` and back in.
{
	const h = harness();
	void runMenu(deps(true), [], h.ctx);

	const menu = await h.next();
	push(render(menu));
	menu.handleInput(KEYS.down); // move to Models
	push(render(menu));
	menu.handleInput(KEYS.enter);

	const models = await h.next();
	push(render(models)); // OpenAI tab: the verified default lineup, three checked
	models.handleInput(KEYS.right); // → Anthropic
	push(render(models));
	models.handleInput(KEYS.right); // → Zhipu, the opt-in unverified tab
	push(render(models));
	models.handleInput(KEYS.space); // toggle GLM-5.3 on
	push(render(models));
	models.handleInput(KEYS.escape); // cancel: nothing is written

	const menu2 = await h.next();
	push(render(menu2));
	menu2.handleInput(KEYS.enter); // Status is the first item

	const verified = await h.next();
	push(render(verified));
	// Fold the trust anchors out with `m`, then back in again: the same panel,
	// so the only thing that changes between these frames is the disclosure.
	verified.handleInput(KEYS.more);
	push(render(verified));
	verified.handleInput(KEYS.more);
	push(render(verified));
}
// Act 2 — the same panel after a failed verification.
{
	const h = harness();
	void runMenu(deps(false), [], h.ctx);
	const menu = await h.next();
	push(render(menu));
	menu.handleInput(KEYS.enter);
	const failed = await h.next();
	push(render(failed));
}

// ── render frames and assemble the GIF ─────────────────────────────────────────
const outDir = join(ROOT, "docs");
mkdirSync(outDir, { recursive: true });
const pngs = [];
frames.forEach((frame, i) => {
	const png = join(SANDBOX, `frame-${String(i).padStart(3, "0")}.png`);
	const markup = frameMarkup(frame.lines);
	try {
		// Two steps on purpose: `-negate` in IM7 applies to every image in the
		// list, so negating inline would flip the black canvas white too. Negate
		// the pango raster alone (its white page becomes our black canvas), then
		// composite it onto a fresh black canvas at a fixed offset.
		const raster = join(SANDBOX, `raster-${String(i).padStart(3, "0")}.png`);
		execFileSync("magick", [`pango:${markup}`, "-negate", raster]);
		execFileSync("magick", [
			"-size", `${CANVAS_W}x${CANVAS_H}`,
			`xc:${BG}`,
			raster,
			"-gravity", "NorthWest",
			"-geometry", `+${PAD_X}+${PAD_Y}`,
			"-composite",
			png,
		]);
	} catch (error) {
		console.error(`frame ${i} failed. markup:\n${markup.slice(0, 1500)}`);
		console.error(String(error.stderr ?? error.message));
		throw error;
	}
	pngs.push(png);
});
const sizes = pngs.map((p) => execFileSync("magick", ["identify", "-format", "%wx%h", p]).toString().trim());
if (new Set(sizes).size !== 1) throw new Error(`frames differ in size: ${[...new Set(sizes)].join(", ")}`);
const gif = join(outDir, "wokey-demo.gif");
// Two passes, because `dispose Background` (or a bare Optimize) leaves the
// unchanged part of the canvas transparent — viewers then paint it page-white
// and the black window is gone. Pass 1 optimizes; pass 2 coalesces every frame
// back to a full, correct black canvas, flattens any residual alpha onto BG,
// then re-optimizes. dispose None keeps the loop compositing over the previous
// frame, which is what a real terminal recording looks like.
const pass1 = join(SANDBOX, "pass1.gif");
const args = ["-dispose", "None"];
frames.forEach((frame, i) => args.push("-delay", String(Math.round(frame.delay / 10)), pngs[i]));
args.push("-loop", "0", "-layers", "Optimize", pass1);
execFileSync("magick", args);
execFileSync("magick", [
	pass1,
	"-coalesce",
	"-background", BG,
	"-alpha", "remove",
	"-alpha", "off",
	"-layers", "Optimize",
	gif,
]);

if (process.env.KEEP_FRAMES) console.log(`frames kept in ${SANDBOX}`);
else rmSync(SANDBOX, { recursive: true, force: true });
const { statSync } = await import("node:fs");
const duration = frames.reduce((sum, f) => sum + f.delay, 0);
// Verify what the GIF actually shows: coalesce rebuilds each displayed frame
// full-canvas, so this is what a viewer paints, not what is stored. Also assert
// the canvas is really black and not a transparent hole a viewer fills white.
const coalesced = execFileSync("magick", [gif, "-coalesce", "-format", "%wx%h\n", "info:"]).toString().trim().split("\n");
if (new Set(coalesced).size !== 1) throw new Error(`coalesced frames differ in size: ${[...new Set(coalesced)].join(", ")}`);
// Probe inside the margin (x < PAD_X or y < PAD_Y), where no glyph can land.
for (const [x, y] of [[5, CANVAS_H - 5], [CANVAS_W - 5, 5]]) {
	const px = execFileSync("magick", [gif, "-coalesce", "-background", BG, "-alpha", "remove", "-format", `%[pixel:p{${x},${y}}] `, "info:"])
		.toString()
		.trim()
		.split(/\s+/);
	if (px.some((v) => v !== "srgb(0,0,0)")) throw new Error(`canvas is not black at ${x},${y} on every frame: ${px.join(" ")}`);
}
console.log(`wrote ${gif} (${frames.length} frames, ${coalesced[0]} each after coalesce, ${duration / 1000}s loop, ${(statSync(gif).size / 1024).toFixed(0)} KiB)`);
