# Integration notes (Task 7, 2026-10-04)

Cross-protocol regression coverage for the verified GPT + Claude routes.
No live Wokey key was reachable in this environment, so there are no live
measurements below — everything was verified against recorded live-shaped
fixtures plus the existing mock-relay e2e harness.

## Live smoke test: skipped (no key)

- `WOKEY_API_KEY` is unset in the environment.
- `~/.pi/agent/auth.json` holds `zai-coding-cn`, `google`, `deepseek`,
  and `openai-codex` — no `wokey` entry, so `/login wokey` was never
  performed here.
- Per the task brief, the manual Claude smoke test (text, tool call,
  high/xhigh thinking, cache-repeat pair, `/wokey status` gaps report) was
  **not run**. The fixture suite below covers the same shapes offline.

## Fixtures

`test-fixtures/anthropic-opus-5-5.sse` (+ `-proof.json`) and
`test-fixtures/anthropic-opus-5-5-cache-read.sse` (+ `-proof.json`),
regenerated deterministically with `node scripts/gen-anthropic-fixtures.mjs`.

- Bodies are hand-authored and fully synthetic: `message_start` (model
  `claude-opus-5-5`), an Anthropic `ping`, thinking deltas with redacted
  signature placeholders, a text block, a `get_time` tool_use block,
  `message_delta`, `message_stop`. The main fixture carries
  `cache_creation_input_tokens: 2048`; the repeat carries
  `cache_read_input_tokens: 2048`.
- Sanitization: prompts are the literal placeholder `[fixture prompt
  redacted]`; no API keys, no real user content anywhere in the files.
- What is genuine: each proof's `response_body_sha256` is the sha256 of the
  exact `.sse` body bytes, and the Ed25519 signature verifies under the
  repo's own `buildV2Statement` layout (pinned by the "pins the fixture
  signature" e2e test, so generator drift fails loudly). Attestation stays
  stubbed (`attestation: "fixture-test-only"`, stub derived from the
  fixture's own key/nonce/PCR0) — no Nitro hardware in CI.
- `npm pack --dry-run` confirms fixtures and the generator are NOT shipped
  (17 files: entrypoint, routes, verify/, README/LICENSE/NOTICE, demo gif).

## Measured results (all offline)

- `npm test`: 12 files, 211 tests pass — including 8 new Anthropic-fixture
  e2e cases (verify-with-gaps with Request binding as the only gap, strict
  verified on exact sanitized request bytes, tamper→failed warn-only,
  substitution names both models, ping/tool/thinking/cache survival,
  GPT+Anthropic strip parity across 13-byte chunk splits).
- `npm run typecheck`: clean. `git diff --check`: clean.
- Cross-protocol asserts now pinned: same proof wrapper installs each
  route's own endpoint tuple + served-model reader on both `stream` and
  `streamSimple`; Anthropic `onPayload` keeps tool/thinking/cache blocks
  byte-identical while GPT keeps caller reasoning effort through the Codex
  envelope; a GPT→Claude switch changes API/base URL/policy with provider
  id `wokey` and the single pi-managed credential untouched; cache-read
  tokens price through pi's native cost model (0.03/1M).

## Carried-forward P2 cleanups (in this commit)

- Removed the dead `saveSettings` export from `config.ts` (zero consumers;
  nothing in the extension writes the settings file).
- Fixed the stale `config.ts` settings-store docstring (no longer claims the
  API key lives in `wokey.json`).
- Fixed the vacuous `toContain("key")` assertion in `tui.test.ts` — it now
  pins the full `pi-managed — /login wokey or WOKEY_API_KEY` auth row.

## Residual gap (unchanged, live-only)

Request binding stays `unavailable` on both routes: the relay rewrites the
request body before the enclave sees it. Only a live exchange with a real key
can tell whether byte-exact binding is recoverable (e.g. via the Codex
envelope shaping); the fixtures prove the gap is policy, not plumbing.
