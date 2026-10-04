# Wokey Multi-Protocol Provider Design

**Status:** Approved for implementation planning

## Goal

Evolve `pi-wokey` from a GPT-specific legacy provider into a clean, growable Wokey provider that supports Claude Opus 5.5 through pi's native Anthropic Messages adapter while preserving TEE verification for every supported protocol.

## Decisions

1. Keep one user-facing provider ID: `wokey`.
2. Use pi's native `Provider`/`createProvider` API, not the legacy single-API `registerProvider` wrapper.
3. Dispatch by model API through a provider API map:
   - `openai-responses` for the existing Codex/GPT route;
   - `anthropic-messages` for the Wokey Anthropic route.
4. Separate:
   - protocol integration;
   - Wokey route and trust policy;
   - model capability and pricing metadata.
5. Keep the cryptographic verifier core unchanged. Make its surrounding policy protocol-aware.
6. Use exact accepted `(host, path, method)` endpoint tuples.
7. Extract the served model from integrity-bound response bytes using protocol-specific readers.
8. Use exact model matching, with only explicit aliases where required.
9. Remove legacy configuration compatibility. The only user credential is the Wokey API key, managed by pi's native authentication; users may re-enter it with `/login wokey`.
10. Do not add speculative session-affinity behavior or OpenAI-compatible Claude fallback in the first implementation.

## Route profiles

### `openai-codex`

- API: `openai-responses`
- Relay base URL: `https://api.wokey.ai/v1`
- Signed upstream: `chatgpt.com`, `/backend-api/codex/responses`, `POST`
- Request binding: documented unavailable
- Request policy: existing Codex envelope and session headers
- Served-model reader: Responses `response.created`/`response.completed`

### `anthropic-direct`

- API: `anthropic-messages`
- Relay base URL: `https://api.wokey.ai`
- Signed upstream: `api.anthropic.com`, `/v1/messages`, `POST`
- Request binding: documented unavailable
- Request policy: no plugin-added body transformation and no Codex headers
- Served-model reader: Anthropic `message_start.message.model`

Both routes use the same pinned PCR0, proof event transport, response-byte verification, attestation verification, and warn-only behavior.

## Claude Opus 5.5 metadata

- Model ID: `claude-opus-5-5`
- API: `anthropic-messages`
- Base URL: `https://api.wokey.ai`
- Input: text and image
- Context: 1,000,000
- Max output: 128,000
- Wokey rates per 1M: input `0.60`, output `3.00`, cache read `0.03`, cache write `0.75`
- Thinking map: `off: null`, `minimal: null`, `low: low`, `medium: medium`, `high: high`, `xhigh: xhigh`, `max: max`
- Compatibility: adaptive thinking, mid-conversation effort/system/tool changes, strict tools, no temperature
- Prompt cache: short `300`, long `3600` seconds

## Credentials and preferences

Use pi's native API-key auth with `/login wokey` and `WOKEY_API_KEY`. Remove duplicated API-key storage and route/adapter/trust overrides from `wokey.json`. Retain only narrowly scoped local preferences such as verification enablement and failure notifications if the existing UX still needs them.

## Catalog policy

Keep immutable built-in model definitions and overlay validated live catalog fields. The live catalog may update pricing and operational limits; it may not choose an adapter, route, trust anchor, or untested capability. Unknown catalog models are not automatically exposed.

## Non-goals

- No backward-compatible migration of the old `wokey.json` schema.
- No new custom Anthropic streaming parser.
- No OpenAI-compatible Claude fallback in the initial release.
- No automatic activation of every Anthropic model returned by the catalog.
- No request-binding redesign in this implementation.
