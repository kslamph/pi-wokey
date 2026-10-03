# pi-wokey

A pi provider for **wokey.ai**'s GPT lineup that checks every response against its
[Proof-of-Observation](https://focuxdot.github.io/proof-of-observation/tee-attestation-demo.html)
TEE attestation, and tells you plainly when a response cannot be proven.

It is **warn-only**: an unproven response is surfaced, never suppressed, so a relay
outage or a verifier bug degrades into a notification instead of a dead session.

```
/wokey
✅ verified 12  ❌ failed 0  ⚠️ unproven 1
pinned PCR0 : 437cbab8c2e5dd11…
upstream    : chatgpt.com
adapter     : openai-responses
probing     : on (warn-only)
```

## Install

```bash
cd ~/piext/pi-wokey-provider && npm install

# 1. register the package (absolute local path, in ~/.pi/agent/settings.json)
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.pi/agent/settings.json')
s = json.load(open(p))
pkg = os.path.expanduser('~/piext/pi-wokey-provider')
if pkg not in s['packages']:
    s['packages'].append(pkg); json.dump(s, open(p,'w'), indent=2)
EOF

# 2. set the key (or just run /wokey key <value> inside pi)
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.pi/agent/wokey.json')
json.dump({"apiKey": "sk-..."}, open(p,'w'), indent=2); open(p,'a').write('\n')
os.chmod(p, 0o600)
EOF

pi --list-models        # the 3 wokey models should appear
pi -p --model wokey/gpt-6-luna "hi"
```

Three models register automatically — nothing to pick by hand beyond choosing one in
`/model`:

| Model | In / Out per 1M | Thinking levels offered |
|---|---|---|
| `gpt-6.1-sol` | $0.18 / $0.90 | low, medium, high, xhigh, max |
| `gpt-6-luna` | $0.09 / $0.45 | off, low, medium, high, xhigh, max |
| `gpt-6-astra` | $0.90 / $4.50 | low, medium, high, xhigh, max |

`gpt-6.1-sol` and `gpt-6-astra` have no `off` — reasoning cannot be disabled on them, and
asking for it clamps up to `low`. Only `gpt-6-luna` supports `none`.

Only the GPT-6 generation is exposed — the older `gpt-6-sol` / `gpt-5.6-*` / `gpt-5.5`
rows are superseded and carry neither a price nor a performance advantage. They stay in
`models.ts` as verified reference data so re-enabling one is a single edit to
`ACTIVE_MODEL_IDS`.

Context limits and rates are re-read from `GET /v1/models` on every startup, because
wokey uses `pricing_mode: dynamic_discount`.

### Thinking levels come from model cards, not probing

pi's vocabulary maps 1:1 onto OpenAI's `reasoning.effort`:

```text
pi:   off  minimal  low  medium  high  xhigh  max
OAI:  none minimal  low  medium  high  xhigh  max
```

**The support set comes from OpenAI's model cards, not from probing the relay** — and
that distinction is load-bearing. Probing `api.wokey.ai` reports a *wider* set than the
models actually support:

| | none | minimal | low | medium | high | xhigh | max |
|---|---|---|---|---|---|---|---|
| `gpt-6.1-sol` — model card | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpt-6.1-sol` — gateway | ⚠️ ✅ | ⚠️ ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpt-6-luna` — model card | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpt-6-luna` — gateway | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpt-6-astra` — model card | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `gpt-6-astra` — gateway | ⚠️ ✅ | ⚠️ ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

The gateway accepts `none` on both 6.1-sol and astra, and `minimal` on astra, all of
which OpenAI's model cards explicitly exclude:

> **`gpt-6.1-sol`** — *"`reasoning.effort` supports `low`, `medium` (default), `high`,
> `xhigh`, and `max`. The `none` and `minimal` reasoning efforts are not supported."*

The reason is that wokey rewrites a *known-but-unsupported* effort to a neighbouring
supported one, and hard-rejects only values it cannot place at all — a nonsense value
like `banana` is refused outright with the full vocabulary listed. So probing the
gateway measures **wokey's leniency, not OpenAI's support**. Trusting it would put
`off` and `minimal` in the picker for two models where they do not work, and you would
only find out at request time.

`models.ts` therefore keeps both sets: `reasoningEfforts` (model card — drives the
picker) and `gatewayAcceptedEfforts` (recorded only as evidence, never used). A
regression test asserts the two differ, so the distinction cannot quietly erode.

There is no reserved `"special"` token in pi. The map value is passed straight through as
`reasoning.effort`, so a vendor-specific effort name is reached simply by mapping a pi
level onto it.

## `/wokey` — one command for everything

Settings and the key live in `~/.pi/agent/wokey.json` (mode `600`), alongside `auth.json`
and the other per-extension state files pi already keeps there. Nothing is read from the
current directory or a project-local `.env`, so the extension behaves identically no
matter where pi was launched from.

`/wokey` opens a menu — nothing to memorise:

| Menu item | What it does |
|---|---|
| **Status** | Verdict counters, masked key and which store it came from, pinned PCR0, expected upstream, probing mode, last exchange with every check. |
| **Models** | The lineup with prices, context window and the exact thinking levels each model offers. |
| **Set API key** | Prompts for the key; writes both stores. |
| **Unset API key** | Confirmation prompt; removes both stores. |

The menu loops until you cancel, so you can do several things in one visit. The
subcommands remain for scripting and headless runs (where there is no UI to draw a menu
in, `/wokey` prints status instead):

```bash
/wokey status          /wokey models
/wokey key <value>     /wokey unset
```

Key resolution order: `wokey.json` → pi's own credential store (`auth.json`, entry
`wokey`) → `WOKEY_API_KEY`. After `/wokey unset` the key still works if pi has one
stored, and the command says so rather than pretending you are signed out.

### Seeing the verdict

`/wokey` prints counters and the full check list. Non-`verified` verdicts also go to
stderr, which is the only place they appear under `pi -p` (the request-binding gap is
shown in `/wokey` only, so its repetition does not train you to ignore warnings):

```
[wokey] ❌ wokey verification failed — Response signature: received bytes do not match the signed hash — response was modified
[wokey] ⚠️ wokey response is not attested — Proof present: no tee.proof in the response — nothing was attested
```

Test-only env overrides (unset in normal use): `WOKEY_EXPECTED_HOST`,
`WOKEY_EXPECTED_PCR0`, `WOKEY_EXPECTED_PATH`, `WOKEY_NO_VERIFY=1`.

## Live results (2026-10-03, real paid requests)

`gpt-6-luna` and `gpt-6-sol` were each called once through `api.wokey.ai/v1/responses`
and the proofs verified offline against the pinned anchors:

```
gpt-6-luna → VERIFIED-WITH-GAPS      gpt-6-sol → VERIFIED-WITH-GAPS
  ✓ 远程证明    COSE/P-384 链到 AWS 根 (64:1A:03:21…)   ← real Nitro hardware
  ✓ 证书有效期  叶 notAfter 02:33:51 (hour-scale, as documented)
  ✓ PCR0 比对   437cbab8c2e5dd11… == pinned audited value ← the audited image, running
  ✓ 公钥绑定    signing key == the attested key
  ✓ nonce 绑定
  ✓ 上游 host   chatgpt.com
  ✓ 响应签名    Ed25519 over the statement; response hash matches byte-for-byte
  ✓ 上游路径    /backend-api/codex/responses
  ✗ 请求绑定    see below — structurally unavailable, reported as a gap
```

Both answered `pong` and self-reported their own model id inside the signed response.

### Finding 1 — the upstream is `chatgpt.com`, not `api.openai.com`

The signed `upstream_host` is **`chatgpt.com`** with path **`/backend-api/codex/responses`**
for every GPT model tested. These are **not OpenAI API calls** — wokey serves the GPT
lineup from a paid ChatGPT/Codex subscription, which matches its own pricing page
("from model providers' official APIs *and paid subscriptions*").

That distinction matters: what is proven is "an audited enclave fetched these exact bytes
from a genuine `chatgpt.com` TLS endpoint", not "from OpenAI's API". `api.openai.com` is
still hardcoded as a *rejected* host, so a silent switch to that route would be caught.

### Finding 2 — the adapter choice, and why request binding stays unavailable

`openai-codex-responses` is pi's ChatGPT/Codex adapter and looks like the obvious match
for a `chatgpt.com/backend-api/codex` upstream. It cannot be used: it authenticates as
ChatGPT itself, parsing the key as a JWT for `chatgpt_account_id` and setting
`chatgpt-account-id` / `originator` headers (`openai-codex-responses.js:1272,1292`). A
wokey API key is not a JWT, so it dies with *"Failed to extract accountId from token"* —
and those headers would be a lie anyway, since wokey's gateway injects its own
subscription credentials.

So the provider stays on `openai-responses` and borrows only the Codex *envelope*
(`applyCodexEnvelope` in `stream.ts`): `store:false`, `instructions`,
`text.verbosity`, `include:["reasoning.encrypted_content"]`, `prompt_cache_key`,
`tool_choice`, `parallel_tool_calls`. It fills gaps only and never overwrites
`reasoning`.

**That still did not recover request binding.** Measured with a fully Codex-shaped
390-byte body: sha256 `54481ac5…` vs signed `3b58176f…`. Eight plausible additions
(`conversation_id`, `session_id`, `safety_identifier`, alternate `prompt_cache_key`,
`tools`, …) all missed. A genuine Codex client sends a large `instructions` block and a
full `tools` array; wokey is almost certainly injecting those, and they cannot be
reproduced client-side.

### Adding an upstream if wokey switches route

`expectedHosts` in `config.ts` (or `expectedHosts` in `~/.pi/agent/wokey.json`) lists the
hosts you accept. It ships with exactly one — `chatgpt.com` — because that is the only host
ever observed in a signed proof.

**Do not pre-approve a host from a doc claim.** If wokey starts routing through
`api.openai.com`, the current gate fails loudly and tells you so, which is exactly the
signal you want before accepting it. A pre-approved host would turn that detection off.

Widening needs **one live proof, not a session** — the proof is self-contained:

```bash
# 1. capture a raw SSE response from the new route
curl -sN https://api.wokey.ai/v1/responses -H "authorization: Bearer $WOKEY_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"hi","stream":true}' > capture.sse

# 2. verify it fully, and read off the host and path it signs
npx tsx verifier/verify-real-bundle.ts <bundle> --pcr0 437cbab8…   # from the wokey repo

# 3. only if attestation → AWS root, PCR0 → pinned value, and the signature verifies:
#    add the host. One line.
```

Confirming the other three gates on that single sample is enough: if attestation chains to
the AWS Nitro root, the PCR0 matches the pinned image, and the Ed25519 statement verifies
over that host, then "signed upstream = api.openai.com" means a real certificate for
`api.openai.com` was validated inside the audited enclave. The rest of the chain is
unchanged, so accepting a second host does not weaken attestation, the measurement, the
nonce, the response signature or the body hash — it only stops the route change itself from
being flagged.

Matching is **exact** (case-insensitive), not by suffix: `evil.chatgpt.com` and
`chatgpt.com.evil.net` are both rejected.

### Finding 3 — request binding is structurally unavailable

Byte-identical resend → identical signed hash (the rewrite is deterministic). Same
semantics with reordered keys → *different* hash (it is byte-order sensitive). No
client-side serialisation reproduces it, so `request_body_sha256` commits to wokey's
rewritten body, never yours.

What survives instead: changing one character of the prompt changes the signed hash, and
the served model is read from the integrity-bound response body (protocol §8.6). So the
`请求绑定` line is reported as a known gap and the verdict becomes
`verified-with-gaps` — not a pass, and not a permanent red you learn to ignore.

Both are configurable in `config.ts`: `expectedHost` / `expectedPaths`, and
`requestBinding: "verify" | "unavailable"`.

Checked with a real key against `api.wokey.ai`, so these are measured, not inferred:

| Fact | Result |
|---|---|
| Base URL | **`https://api.wokey.ai/v1`** — the bare `wokey.ai` host rejects API traffic with `wrong_gateway_host`. `/v1` is optional; only a *doubled* `/v1` breaks Claude Code. |
| Thinking level | ✅ honoured — `reasoning.effort` `none` vs `high` gives ~7 vs ~58 output tokens on the same task (5 runs, consistent). |
| Envelope | wokey injects its own Codex envelope; even a Codex-shaped request is rewritten. |
| Proof delivery | ✅ `event: tee.proof` emitted on both `gpt-6-luna` and `gpt-6-sol`; verified against real Nitro hardware. |
| `/v1/chat/completions` | Works. `messages` required. |
| `/v1/responses` | Works. `input` required; `instructions`, `store:false`, `stream` all accepted. The relay's own 400 helpfully states the difference. |
| `GET /v1/models` | 200, 39 models, real `pricing` + `context_length` + `max_completion_tokens`. Synced on startup. |
| Model ids | All 8 baked-in ids exist; no GPT model is missing from the lineup. |
| `gpt-6-sol` pricing | in $0.18, out $0.90, cache-read $0.018 per 1M — matches this table. |
| Context window | **1,050,000** (not the 400k first assumed), max output 128,000. |
| Key auth | Valid: a bad key returns `401 invalid_api_key`, yours returns `402 insufficient_balance`. |
| Model validation | Runs *before* billing — a bad id returns `404 model_not_found`, a good one reaches `402`. |

**`reasoning_output_tokens` is never reported** by the chatgpt.com Codex backend, and
pi's own codex adapter does not read it either. Its absence is not a signal — use
`output_tokens` deltas instead, which reproduce cleanly.

## Trust model — read this once

**What a green report establishes.** An enclave running the image whose measurement
equals your pinned `PCR0` established a real TLS connection to a party holding a valid
certificate for `chatgpt.com`, fetched exactly the bytes you received, and signed
that fact. Nothing in between could alter them.

**What it does not establish.** That OpenAI's own API served the model you asked
for. The signed upstream is a `chatgpt.com` TLS endpoint, not `api.openai.com` —
OpenAI does not sign responses, so the strongest available claim is "a valid
`chatgpt.com` certificate was observed". This ceiling is structural — no verifier can
exceed it.

**Where the remaining trust sits** (protocol §10.6–10.7):

| Trust | Status |
|---|---|
| AWS Nitro root (pinned by fingerprint) | Hardware root. A compelled or broken Nitro service defeats this. |
| `EXPECTED_PCR0` in `config.ts` | **Operator-published.** Inherited trust in wokey. See below. |
| Enclave source is backdoor-free | Not established. Reproducible build proves *the running code equals the public source*, not that the source is correct. |
| Response/request body hashing | Exact bytes, zero canonicalization. |

**Upgrading the PCR0 anchor.** The shipped `PUBLISHED_PCR0` is the value from the
project's `docs/tee-reproducible-build.md`. Accepting it means trusting the operator.
To remove that, build the enclave yourself from the pinned revision and replace the
constant — see that document's "第三方复算与比对" section. Even without doing the full
aarch64 build, pinning the value on day one and alerting on drift converts this into
**change detection**, which is the attack that actually matters: not lying today, but
quietly downgrading next quarter.

**What is checked on every response:** attestation chains to the pinned AWS Nitro root ·
certificate validity · `PCR0` equals your pinned constant · signing key is the attested
key · nonce binding · Ed25519 statement over host/path/method/status/content-type ·
response body hash · request body hash · upstream host · upstream path.

**Known gaps, deliberately not papered over:**

- **Headers and query strings are unsigned** (protocol §5.4). Model and thinking level
  live in the request body and *are* bound, but a relay can alter beta feature flags.
- **The nonce is relay-generated**, not a challenge you supply. A genuine earlier
  exchange can be replayed inside the certificate validity window.
- **Not publicly verifiable.** Only you, holding both byte strings, can check the
  content bindings.
- **Coverage is enforced by this extension** (a proofless response is flagged
  `unproven`), which is strictly stronger than the passive verifier — but it is still
  per-exchange.

## The one deliberate divergence from upstream

Upstream's own browser verifier (`docs/tee-verify.html`) resolves its "audited PCR0"
via `expectedPcr0FromObject()`, whose **last fallback is `proof.pcr0`** — the value
declared by the proof under test. Paste a relay-supplied bundle and the trust anchor
populates from the artifact being judged, so the PCR0 gate passes for any image at all.
Upstream's own spec §7 calls that field "advisory only"; their CLI is safe because
`--pcr0` is a required argument.

This extension never reads a PCR0 from the wire. There is a regression test for it
(`does not let the proof's own pcr0 satisfy the PCR0 gate`).

Two more deliberate choices:

- The probe verifies **the bytes the client received**, not the raw wire bytes. A relay
  forging a mid-stream `event: tee.proof` to truncate output therefore fails the response
  hash and is reported, rather than passing quietly.
- An unset `EXPECTED_PCR0` reports **failure**, not a pass. A missing anchor means model
  substitution is unchecked, and it says so instead of showing green.

## How it hooks in

`pi`'s `onResponse` only yields `{status, headers}` and `provider_stream_event` is
documented as "not necessarily the original HTTP bytes or SSE frame" — neither can see
the bytes the statement commits to. So this registers a provider with a custom
`streamSimple` that injects a probing `fetch` through `StreamOptions`:

```
fetch wrapper ─┬─ tee() ─┬─→ verifier branch   (accumulates, verifies at end)
               │         └─→ client branch    → strip trailing tee.proof → pi's OpenAI adapter
               └─ captures exact request-body octets
```

Streaming is preserved; pi's own adapter still does all message conversion, tool
handling and usage accounting. The trailing `event: tee.proof` record is stripped before
pi sees it (same as upstream's own tee-verify-proxy), so the adapter never meets an SSE
event it doesn't know.

## Vendored code

`verify/signing.ts`, `verify/verify-attestation-cose.mjs` and `verify/tee-verify-core.ts`
are vendored **verbatim** from [focuxdot/proof-of-observation](https://github.com/focuxdot/proof-of-observation)
at commit `4bb11f36370ca5d574310882e0e6aff30c424287`. Upstream is dual-licensed MIT +
Apache-2.0; this distribution exercises the **Apache-2.0** option for those files, and
their upstream headers are retained unedited as Apache-2.0 §4(c) requires. Full terms:
`LICENSE` (this project, Apache-2.0) and `NOTICE` (attribution + vendored file list).
They hold the security-critical crypto and wire parsing and are deliberately not
hand-edited; upstream's own test suite covers them. Everything else is original.

## Files

| File | Role |
|---|---|
| `config.ts` | Trust anchors, upstream expectations, toggles. **Edit this.** |
| `models.ts` | The GPT lineup with wokey's rates. |
| `stream.ts` | `streamSimple` — delegates to pi's adapter with the probing fetch. |
| `verify/probe.ts` | Byte capture, proof stripping, gate orchestration. |
| `index.ts` | Registration, `/wokey` command, warnings. |
| `probe.test.ts` | 30 tests: golden vectors, chunk boundaries, every gate. |

## Tests

```bash
npm test          # 68 tests
npm run typecheck
```

The hardware half (COSE/P-384 → AWS Nitro root) needs a real attestation document, so
those gates run against a stub verifier. Everything this extension owns — proof-record
handling, byte-exact request capture, chunk-boundary stripping, host/path gates, and the
PCR0 defense — is tested for real.

## Troubleshooting

**Every response says `unproven`.** Proofs were confirmed working on 2026-10-03, so this
now means something regressed at the relay or in between. Check with curl:

```bash
curl -sN https://api.wokey.ai/v1/responses \
  -H "authorization: Bearer $WOKEY_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"hi","stream":true}' | tail -5
```

You should see a trailing `event: tee.proof`. If not, there is nothing to verify.

**`402 insufficient_balance` everywhere.** The key is fine — auth passed. The relay
bills before generating, so no response and no proof exist to check.

**`wrong_gateway_host`.** `baseUrl` is set to `wokey.ai` instead of `api.wokey.ai`.

**`请求绑定` missing.** Request bytes weren't captured — the SDK streamed the body.
Model/thinking-level binding is then unverified; everything else still runs.

**Adapter errors.** wokey may only expose `/v1/chat/completions`. Set
`api: "openai-completions"` in `config.ts`.