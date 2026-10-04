# Wokey Multi-Protocol Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `pi-wokey` into one native, verified Wokey provider supporting the existing GPT route and Claude Opus 5.5 through pi's Anthropic Messages adapter.

**Architecture:** Keep one `wokey` provider ID, but model definitions select a route profile. Route profiles own API type, relay base URL, request/header policy, accepted signed endpoint, and protocol-specific served-model extraction. A native pi `Provider` dispatches to verified wrappers around pi's OpenAI Responses and Anthropic Messages implementations.

**Tech Stack:** TypeScript, Node.js 22+, `@earendil-works/pi-ai` native `Provider`/`createProvider`, pi built-in API implementations, Vitest, AWS Nitro/COSE/Ed25519 verifier already vendored in `verify/`.

**Spec:** `docs/superpowers/specs/2026-10-04-wokey-multi-protocol-provider-design.md`

## Global Constraints

- Keep one provider ID: `wokey`.
- Use pi's native `Provider`/`createProvider` API with an API implementation map; do not use the legacy single-API custom wrapper for the final provider.
- Do not copy or implement a custom Anthropic stream parser.
- Preserve the existing warn-only verification behavior.
- Keep the cryptographic verifier core unchanged unless a test proves a protocol-neutral defect.
- Trust only exact measured `(host, path, method)` endpoint tuples.
- Extract served model identity from integrity-bound response bytes.
- Do not add backward-compatible configuration migration.
- Manage the sole API key through pi auth (`/login wokey`) or `WOKEY_API_KEY`.
- Do not automatically expose unknown live-catalog models or speculative Claude/OpenAI fallbacks.
- The final test command is `npm test && npm run typecheck`.

## Review Focus

- A Claude model must not bypass the proof wrapper merely because its API is `anthropic-messages`; test native provider dispatch for both `stream` and `streamSimple`.
- A Claude response must not fail verification because its model is reported in `message_start.message.model`; test exact Anthropic model extraction and substitution rejection.
- A Claude request must use `https://api.wokey.ai` rather than the GPT `/v1` base; test the route URL and absence of Codex envelope/session headers.
- A route change must not be accepted through independent host/path matching; test host, path, and method as one exact endpoint tuple.
- A 1-hour Anthropic cache write must be charged correctly through pi's `cacheWrite1h` accounting; test usage/cost metadata and the `short`/`long` cache lifetimes.

---

## File map

### Create

- `routes.ts` — immutable Wokey route profiles and protocol-specific request/response policies.
- `routes.test.ts` — route invariants and route-policy tests.
- `provider.ts` — native Wokey provider factory, native auth, model dispatch, and catalog refresh wiring.
- `provider.test.ts` — native provider/auth/dispatch tests.

### Modify

- `config.ts` — reduce configuration to verification/preferences; remove API-key duplication and user-editable route/trust overrides.
- `config.test.ts` — pin the new configuration contract.
- `models.ts` — route-aware model definitions, Claude metadata, typed API-specific capabilities, and validated catalog overlay.
- `models.test.ts` — catalog, metadata, cache, cost, and mixed-API model tests.
- `stream.ts` — verified wrappers around pi's native API implementations for both `stream` and `streamSimple`.
- `stream.test.ts` — route-specific wrapper and hook-preservation tests.
- `verify/probe.ts` — route policy input, exact endpoint validation, protocol-specific model extraction, and exact model matching.
- `probe.test.ts` — GPT and Anthropic proof fixtures and verification gates.
- `balance.ts` — use the stable Wokey API root rather than deriving dashboard URLs from one model route.
- `tui.ts` — remove duplicate key management, display mixed models/routes, and show pi-managed authentication guidance.
- `tui.test.ts` — update command/status/model rendering tests.
- `index.ts` — register the native provider, wire report state and UI, and remove manual legacy provider re-registration/catalog synchronization.
- `README.md` — document `/login wokey`, Claude support, route-specific verification, and no legacy settings migration.
- `package.json` — update description/keywords/files if needed for the new multi-protocol provider surface.

### Remove or retire

- Legacy API-key read/write helpers and their tests once native auth owns credential resolution.
- Legacy `createWokeyStream` provider registration path after its behavior is covered by the native provider wrappers.

---

## Task 1: Establish route profiles and clean configuration

**Files:**
- Create: `routes.ts`
- Create: `routes.test.ts`
- Modify: `config.ts`
- Modify: `config.test.ts`

**Interfaces:**
- Produces `WokeyRouteId = "openai-codex" | "anthropic-direct"`.
- Produces `WokeyRoute` with:
  - `id: WokeyRouteId`;
  - `api: "openai-responses" | "anthropic-messages"`;
  - `baseUrl: string`;
  - `endpoint: { host: string; path: string; method: "POST" }`;
  - `requestBinding: "verify" | "unavailable"`;
  - `extractServedModel(body: Buffer): string | undefined`;
  - `transformPayload(payload: unknown, cacheKey: string): Record<string, unknown>`;
  - `transformHeaders(headers: Record<string, string | null>, cacheKey: string): Record<string, string | null>`.
- Produces immutable `ROUTES: Readonly<Record<WokeyRouteId, WokeyRoute>>` and `getRoute(id): WokeyRoute`.
- `WokeyConfig` retains only shared verification/preferences: `expectedPcr0`, proof-header name, `verify`, and `notifyOnFailure`.

- [ ] **Step 1: Write failing route invariant tests**
  - Assert GPT route is `openai-responses`, base URL `https://api.wokey.ai/v1`, endpoint `chatgpt.com` + `/backend-api/codex/responses` + `POST`.
  - Assert Anthropic route is `anthropic-messages`, base URL `https://api.wokey.ai`, endpoint `api.anthropic.com` + `/v1/messages` + `POST`.
  - Assert both routes use `PUBLISHED_PCR0` through shared config and both mark request binding unavailable.
  - Assert Anthropic request policy does not add a Codex envelope or Codex session headers.

- [ ] **Step 2: Run route/config tests and verify they fail**

  Run: `npx vitest run routes.test.ts config.test.ts`

  Expected: FAIL because the route registry and reduced config do not exist yet.

- [ ] **Step 3: Implement immutable route profiles**
  - Move all GPT-specific URL/trust/envelope assumptions out of `WokeyConfig` into the GPT route.
  - Add the Anthropic route with the exact measured endpoint tuple.
  - Define protocol-neutral policy function signatures so later routes can supply a different API without editing verification internals.
  - Keep PCR0 global and code-pinned; do not expose endpoint trust anchors through user settings.

- [ ] **Step 4: Simplify configuration and remove legacy overrides**
  - Remove `baseUrl`, `api`, `expectedHost`, `expectedHosts`, `expectedPaths`, `codexEnvelope`, and API-key fields from persisted user settings.
  - Preserve only verification notification/enablement preferences if they remain necessary.
  - Do not read or migrate the old schema; an old settings file is ignored/replaced and the user is told to authenticate again.

- [ ] **Step 5: Run tests and typecheck**

  Run: `npx vitest run routes.test.ts config.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add routes.ts routes.test.ts config.ts config.test.ts
  git commit -m "refactor: separate wokey routes from shared config"
  ```

---

## Task 2: Make model metadata route-aware and add Claude Opus 5.5

**Files:**
- Modify: `models.ts`
- Modify: `models.test.ts`

**Interfaces:**
- `WokeyModelSpec` gains `route: WokeyRouteId` and API-specific metadata.
- `toModel(spec: WokeyModelSpec): Model<Api>` selects `api` and `baseUrl` from the route profile instead of global config.
- `activeModels(): Model<Api>[]`, `activeSpecs(): WokeyModelSpec[]` no longer require a global API/base-url config.
- Catalog refresh returns validated resolved definitions without allowing live data to select routes or capabilities.

- [ ] **Step 1: Add failing mixed-model tests**
  - Assert existing active GPT models resolve to `openai-responses` and the GPT base URL.
  - Add an active `claude-opus-5-5` definition and assert it resolves to `anthropic-messages` and `https://api.wokey.ai`.
  - Assert Opus 5.5 has exactly the approved thinking map and Anthropic compatibility flags.
  - Assert Opus 5.5 has text/image input, 1M context, 128k max output, `{short: 300, long: 3600}` cache lifetime, and Wokey rates `$0.60/$3.00/$0.03/$0.75`.
  - Assert GPT and Claude models can coexist in one `activeModels()` result.

- [ ] **Step 2: Add failing catalog/cost tests**
  - Assert live catalog refresh updates prices/context/max output for known IDs only.
  - Assert a catalog entry cannot change a model's route, API, trust policy, thinking map, or compatibility flags.
  - Assert `input_cache_write_1h` is parsed for validation/display but the model uses pi's base `cacheWrite` plus native `cacheWrite1h` cost calculation.
  - Assert malformed, absent, zero, and negative pricing fields do not erase valid baked-in values.

- [ ] **Step 3: Run model tests and verify they fail**

  Run: `npx vitest run models.test.ts`

  Expected: FAIL because the model table and conversion are currently GPT/global-config-only.

- [ ] **Step 4: Implement route-aware definitions**
  - Replace `GPT_MODELS` as the primary catalog with a provider-wide model list; retain inactive reference rows only when they have a route and valid metadata.
  - Add exactly `claude-opus-5-5` initially; do not activate every Anthropic catalog result.
  - Store Anthropic `compat`, `thinkingLevelMap`, `promptCache`, and `inputLimits` as typed model metadata.
  - Remove the unsafe cast that lets OpenAI-only metadata such as `{ retention: "in-memory" }` masquerade as `ModelPromptCache`.
  - Keep cost units as USD per 1M tokens.

- [ ] **Step 5: Refactor catalog overlay**
  - Make refresh update known model facts without mutating route or capability policy.
  - Preserve the current “missing catalog data does not shrink a known value” behavior unless the field is explicitly invalid.
  - Validate Wokey's 1-hour cache-write rate against Anthropic's native `2 × input` calculation and surface a warning if it diverges.

- [ ] **Step 6: Run model tests and typecheck**

  Run: `npx vitest run models.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add models.ts models.test.ts
  git commit -m "feat: add route-aware Claude model metadata"
  ```

---

## Task 3: Refactor proof policy for both response dialects

**Files:**
- Modify: `verify/probe.ts`
- Modify: `probe.test.ts`

**Interfaces:**
- `VerificationPolicy` is `{ expectedPcr0: string; endpoint: WokeyRoute["endpoint"]; requestBinding: WokeyRoute["requestBinding"] }`.
- `VerifyInput` retains wire/client/request bytes and expected model, plus `extractServedModel: WokeyRoute["extractServedModel"]`; it no longer assumes Responses events.
- `verifyExchange(input: VerifyInput, policy: VerificationPolicy): { report: ProofVerdict }` validates the exact endpoint tuple, protocol-specific served model, and existing proof checks.
- `createProbingFetch(deps: { policy: VerificationPolicy; onReport(report: ProofReport): void; expectedModel?: string; extractServedModel: WokeyRoute["extractServedModel"]; attestationVerifier?: AttestationVerifier }): typeof fetch` remains the injected fetch seam.

- [ ] **Step 1: Add failing Anthropic fixture tests**
  - Build a proof fixture with `api.anthropic.com`, `/v1/messages`, `POST`, and an SSE body containing `message_start` with `message.model = "claude-opus-5-5"`.
  - Assert the served-model check passes for the requested Claude model.
  - Assert a Claude substitution fails and names both served and requested model IDs.
  - Assert the existing GPT fixture still passes.

- [ ] **Step 2: Add failing exact-endpoint tests**
  - Assert wrong host, wrong path, and wrong method each fail.
  - Assert a host from one route cannot combine with a path from another route.
  - Assert path suffixes or unrelated accepted-list combinations are not accepted.

- [ ] **Step 3: Run probe tests and verify they fail**

  Run: `npx vitest run probe.test.ts`

  Expected: FAIL because model extraction and endpoint policy are currently GPT/global-config-specific.

- [ ] **Step 4: Implement protocol-specific model extraction**
  - Move the current Responses event reader behind the route policy.
  - Add Anthropic `message_start.message.model` extraction.
  - Support the corresponding non-streaming JSON shape only if the underlying adapter can deliver it through the same fetch wrapper.
  - Return `undefined` when the response body does not identify a model; do not treat unknown identity as a successful match.

- [ ] **Step 5: Implement exact endpoint validation**
  - Compare signed host, path, and method against the route's exact tuple.
  - Keep the existing proof/attestation/signature/response-byte checks unchanged.
  - Keep request binding as a documented non-blocking gap for both measured routes.
  - Use exact model equality, with an explicit alias map only if a real Wokey response requires one.

- [ ] **Step 6: Run the full probe suite**

  Run: `npx vitest run probe.test.ts probe.e2e.test.ts`

  Expected: PASS, including existing PCR0, nonce, signature, proof stripping, and English-diagnostic tests.

- [ ] **Step 7: Commit**

  ```bash
  git add verify/probe.ts probe.test.ts
  git commit -m "refactor: verify protocol-specific Wokey routes"
  ```

---

## Task 4: Build verified wrappers around pi's native API implementations

**Files:**
- Modify: `stream.ts`
- Modify: `stream.test.ts`

**Interfaces:**
- `createVerifiedStreams(route: WokeyRoute, config: WokeyConfig, onReport: (report: ProofReport) => void, native: ProviderStreams): ProviderStreams` wraps the native implementation's `stream` and `streamSimple` methods.
- The wrapper consumes `WokeyRoute`, shared preferences, `expectedModel` from the model argument, and native `SimpleStreamOptions`/`StreamOptions`.
- The wrapper produces the same pi stream contract as the underlying adapter and never changes model API/base URL metadata.

- [ ] **Step 1: Add failing dispatch/wrapper tests**
  - Mock native OpenAI Responses and Anthropic Messages implementations.
  - Assert both `stream` and `streamSimple` receive a probing fetch.
  - Assert caller `onPayload` runs before route policy transformation.
  - Assert caller `onResponse` and provider-stream hooks are preserved.
  - Assert GPT requests receive Codex envelope/session headers.
  - Assert Anthropic requests receive no Codex envelope, `session-id`, `x-client-request-id`, or `session_id: null`.
  - Assert proof-mode headers are removed for both routes.
  - Assert caller-provided API keys are passed through unchanged.

- [ ] **Step 2: Run stream tests and verify they fail**

  Run: `npx vitest run stream.test.ts`

  Expected: FAIL because the current wrapper only targets the legacy OpenAI path.

- [ ] **Step 3: Implement the route-aware wrapper**
  - Preserve the existing Codex payload/header behavior byte-for-byte for the GPT route.
  - Make the Anthropic payload transform identity after the caller's `onPayload` hook.
  - Inject `createProbingFetch` with the route's verification policy.
  - Do not fall back from an unknown API to OpenAI; throw a clear unsupported-API error.
  - Avoid duplicating `onPayload` or replacing any pi instrumentation hook.
  - Keep request abort, timeout, and provider environment fields intact.

- [ ] **Step 4: Run stream tests and typecheck**

  Run: `npx vitest run stream.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add stream.ts stream.test.ts
  git commit -m "feat: wrap native Wokey API streams with verification"
  ```

---

## Task 5: Register one native Wokey provider with native auth and catalog refresh

**Files:**
- Create: `provider.ts`
- Create: `provider.test.ts`
- Modify: `index.ts`
- Modify: `balance.ts`

**Interfaces:**
- `createWokeyProvider(options): Provider<"openai-responses" | "anthropic-messages">` creates the complete native provider.
- Provider auth uses pi's `envApiKeyAuth("Wokey API key", ["WOKEY_API_KEY"])` or an equivalent native API-key auth object with `/login` support.
- Provider API map contains verified wrappers for `openai-responses` and `anthropic-messages`.
- Native `refreshModels`/`fetchModels` returns the route-aware known model list after a validated catalog overlay.
- `fetchBalance(rootUrl, key, signal?)` uses the stable Wokey API root and does not infer its URL from a model base URL.

- [ ] **Step 1: Add failing native provider tests**
  - Assert the provider ID is `wokey` and exposes one provider with both API implementations.
  - Assert `/login` auth is declared and no Wokey API key is stored in custom settings.
  - Assert the provider returns both GPT and Claude models.
  - Assert model dispatch selects the OpenAI wrapper for GPT and Anthropic wrapper for Claude.
  - Assert an unsupported model API produces a provider error rather than OpenAI fallback.
  - Assert catalog refresh uses `GET https://api.wokey.ai/v1/models` and passes its abort signal.
  - Assert balance uses the stable relay root and Bearer authentication.

- [ ] **Step 2: Run provider tests and verify they fail**

  Run: `npx vitest run provider.test.ts`

  Expected: FAIL because the extension still registers a legacy ProviderConfig and manually resolves credentials/catalogs.

- [ ] **Step 3: Implement `createWokeyProvider`**
  - Use `createProvider` from `@earendil-works/pi-ai` with an API implementation map.
  - Pass route-specific models with model-level `api` and `baseUrl`.
  - Use native auth so `/login wokey`, `auth.json`, and `WOKEY_API_KEY` are authoritative.
  - Wrap both native APIs with Task 4's verified streams.
  - Make catalog refresh transactional; retain the last known static catalog when network refresh fails.

- [ ] **Step 4: Replace legacy registration in `index.ts`**
  - Register the complete native provider object through `pi.registerProvider(provider)`.
  - Remove manual unregister/re-register catalog synchronization.
  - Keep report counters and notifications independent of model protocol.
  - Obtain credentials through pi's provider/model registry for balance/status actions rather than reading a second key store.

- [ ] **Step 5: Run provider tests and typecheck**

  Run: `npx vitest run provider.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add provider.ts provider.test.ts index.ts balance.ts
  git commit -m "feat: register Wokey as a native multi-API provider"
  ```

---

## Task 6: Simplify commands/UI and remove duplicate credential management

**Files:**
- Modify: `tui.ts`
- Modify: `tui.test.ts`
- Modify: `config.ts` tests as needed
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add failing UI/documentation tests**
  - Assert `/wokey models` renders both GPT and Claude rows, including route/API identity and thinking levels.
  - Assert status identifies the pinned PCR0, the last signed endpoint tuple, verification state, and pi-managed auth guidance.
  - Assert the command no longer claims to write/remove a duplicate key in `wokey.json`.
  - Assert model prices and context limits remain formatted correctly.

- [ ] **Step 2: Run UI tests and verify they fail**

  Run: `npx vitest run tui.test.ts`

  Expected: FAIL because the UI currently assumes GPT-only metadata and custom key stores.

- [ ] **Step 3: Remove custom key commands and update status/model panels**
  - Replace `/wokey key` and `/wokey unset` with guidance to use `/login wokey` and `/logout wokey`.
  - Remove `resolveApiKey`, `writePiCredential`, and `clearPiCredential` usage from the UI.
  - Display route-specific signed host/path/method from the last proof report.
  - Show model family/API in the model table.
  - Keep `/wokey status`, `/wokey models`, refresh, and verification counters.

- [ ] **Step 4: Update README and package metadata**
  - Document Claude Opus 5.5 and the native Anthropic Messages route.
  - Document `https://api.wokey.ai/v1` only for OpenAI-compatible requests and `https://api.wokey.ai` for Anthropic Messages.
  - Document `/login wokey`/`WOKEY_API_KEY` as the only credential configuration.
  - Remove old settings-schema, adapter override, and key-mirroring instructions.
  - Explain that an existing incompatible custom settings file should be removed and the key re-entered.
  - Update description/keywords from GPT-only wording.

- [ ] **Step 5: Run UI tests and typecheck**

  Run: `npx vitest run tui.test.ts && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add tui.ts tui.test.ts README.md package.json config.ts config.test.ts
  git commit -m "docs: expose native multi-model Wokey setup"
  ```

---

## Task 7: Add live-shaped integration fixtures and final regression coverage

**Files:**
- Modify: `probe.e2e.test.ts`
- Modify: `stream.test.ts`
- Modify: `models.test.ts`
- Create if needed: `test-fixtures/anthropic-opus-5-5.sse`
- Create if needed: `test-fixtures/anthropic-opus-5-5-proof.json`
- Modify: `DEV-NOTES.md` or `docs/` with measured integration notes

- [ ] **Step 1: Add recorded Anthropic fixtures**
  - Include a sanitized `message_start`, thinking/text/tool events, `message_delta`, `message_stop`, and trailing `tee.proof` fixture.
  - Preserve the proof's signed response hash relationship; do not commit API keys or full sensitive prompts.
  - Include a fixture with `cache_creation` and a fixture with `cache_read_input_tokens` for usage parsing if practical.

- [ ] **Step 2: Add cross-protocol regression tests**
  - Run the same proof wrapper tests against GPT Responses and Anthropic Messages bodies.
  - Assert proof stripping leaves valid downstream SSE for both adapters.
  - Assert Anthropic ping events remain in the signed body and are ignored by pi's adapter as expected.
  - Assert a model switch from GPT to Claude changes API/base URL/policy without changing provider ID or credentials.
  - Assert tool calls, thinking signatures, cache usage, and response model identity survive normalization.

- [ ] **Step 3: Add integration verification commands**

  Run:

  ```bash
  npm test
  npm run typecheck
  ```

  If a Wokey key is available, run a small manual smoke test with `claude-opus-5-5`:
  - ordinary text response;
  - one tool call;
  - high/xhigh thinking;
  - two identical cacheable requests;
  - inspect `/wokey status` for a verified-with-gaps report whose only gap is request binding.

  Expected: all automated tests pass; live Claude reports `api.anthropic.com /v1/messages`; no Claude call reports a false served-model failure; cache read tokens appear on the repeated request.

- [ ] **Step 4: Review package contents and git diff**

  Run:

  ```bash
  git diff --check
  git status --short
  npm pack --dry-run
  ```

  Expected: no whitespace errors, no secrets, required route/provider/verification files included, and no obsolete custom credential files shipped.

- [ ] **Step 5: Commit final integration coverage**

  ```bash
  git add probe.e2e.test.ts stream.test.ts models.test.ts test-fixtures DEV-NOTES.md docs
  git commit -m "test: cover verified GPT and Claude routes"
  ```

---

## Final acceptance criteria

- `/model wokey/claude-opus-5-5` uses pi's native Anthropic Messages adapter.
- Both native `stream` and `streamSimple` paths pass through Wokey proof verification.
- Claude requests use `https://api.wokey.ai` and never receive Codex envelope/session transformations.
- Claude proof verification accepts only `api.anthropic.com`, `/v1/messages`, `POST`.
- Claude served-model verification reads `message_start.message.model` and rejects substitutions.
- GPT verification behavior remains intact.
- One `wokey` provider ID and one pi-managed API key serve both protocols.
- 1-hour Anthropic cache usage is represented and charged through pi's native usage/cost model.
- No legacy Wokey config migration code remains.
- `npm test` and `npm run typecheck` pass.
