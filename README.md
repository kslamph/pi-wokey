# pi-wokey

A [pi](https://pi.dev) provider for **wokey.ai**'s GPT lineup that verifies every
response against wokey's TEE attestation, and tells you plainly when a response cannot
be proven.

It is **warn-only**: an unproven response is surfaced, never suppressed, so a relay
outage or a verifier bug degrades into a notification instead of a dead session.

## Features

- **Three GPT-6 models** — `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, with wokey's
  live pricing and context limits.
- **Per-response verification** — every reply carries a signed Proof-of-Observation
  statement. The extension checks it in-process and labels the exchange
  `verified`, `verified-with-gaps`, `failed`, or `unproven`.
- **Warn-only** — a failed or absent proof is reported; the reply is always delivered.
- **`/wokey` manager** — Status, Models, and set/unset key, rendered as native TUI
  panels. Press `r` in Status to refresh the key and catalog.
- **Terminal thinking-level support** per model, taken from OpenAI's model cards.
- **Keys in one place** — `~/.pi/agent/wokey.json` (mode `600`), mirrored into pi's
  credential store so requests authenticate.
- **Live catalog sync** — context windows and rates are re-read from
  `GET /v1/models` on startup.

## Install

```bash
cd ~/piext/pi-wokey-provider && npm install
```

Register the package (absolute local path, in `~/.pi/agent/settings.json`):

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.pi/agent/settings.json')
s = json.load(open(p))
pkg = os.path.expanduser('~/piext/pi-wokey-provider')
if pkg not in s['packages']:
    s['packages'].append(pkg); json.dump(s, open(p,'w'), indent=2)
EOF
```

Set the key — either now, or later with `/wokey key <value>` inside pi:

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.pi/agent/wokey.json')
json.dump({"apiKey": "sk-..."}, open(p,'w'), indent=2); open(p,'a').write('\n')
os.chmod(p, 0o600)
EOF
```

Then:

```bash
pi --list-models                        # the 3 wokey models appear
pi -p --model wokey/gpt-6-luna "hi"
```

## Usage

### `/wokey`

`/wokey` opens a menu (arrow keys, enter to pick, esc to cancel). It loops, so you can
do several things in one visit:

| Menu item | What it does |
|---|---|
| **Status** | Verdict counters, masked key and which store it came from, pinned image measurement, expected upstream, probing mode, and the last exchange with every check. Press `r` to re-resolve the key and re-sync the catalog. |
| **Models** | The lineup with prices, context window, and the exact thinking levels each model offers. |
| **Set API key** | Prompts for the key; writes both stores. |
| **Unset API key** | Confirms, then removes the key from both stores. |

In a headless run (`pi -p`, or no UI), the subcommands print instead of opening a panel:

```bash
/wokey status          /wokey models
/wokey key <value>     /wokey unset
```

Key resolution order: `~/.pi/agent/wokey.json` → pi's own credential store
(`auth.json`, entry `wokey`) → the `WOKEY_API_KEY` environment variable. After
`/wokey unset` the key still works if pi has one stored, and the command says so rather
than pretending you are signed out.

### Seeing the verdict

`/wokey` shows the counters and the full check list for the last exchange. Non-`verified`
verdicts are also mirrored to stderr, which is the only place they appear under
`pi -p`:

```
[wokey] ❌ wokey verification failed — Response signature: received bytes do not match the signed hash — response was modified
[wokey] ⚠️ wokey response is not attested — Proof present: no tee.proof in the response — nothing was attested
```

The four verdicts:

| Verdict | Meaning |
|---|---|
| ✅ `verified` | Every check passed. |
| 🟡 `verified-with-gaps` | Every achievable check passed, but one structural check is unavailable (currently: request binding — see below). Shown in `/wokey`, not warned every turn. |
| ❌ `failed` | Attestation, signature, hashes, or the upstream host/path did not match. Treat the response as untrusted. |
| ⚠️ `unproven` | No proof record was present, so nothing could be verified. |

### Models

| Model | In / Out per 1M | Thinking levels offered |
|---|---|---|
| `gpt-6.1-sol` | $0.18 / $0.90 | low, medium, high, xhigh, max |
| `gpt-6-luna` | $0.09 / $0.45 | off, low, medium, high, xhigh, max |
| `gpt-6-astra` | $0.90 / $4.50 | low, medium, high, xhigh, max |

`gpt-6.1-sol` and `gpt-6-astra` cannot disable reasoning: asking for `off` clamps up to
`low`. Only `gpt-6-luna` supports `none`. Thinking levels come from OpenAI's model
cards, not from probing the relay (the gateway accepts some efforts the models do not
actually support).

Context limits and rates are re-read from `GET /v1/models` on every startup, because
wokey uses `pricing_mode: dynamic_discount`.

## What "verified" means

Alongside the model output, wokey returns a **Proof-of-Observation**: a statement signed
by the enclave that handled your request, plus the attestation document that proves what
that enclave is.

- wokey runs the upstream call inside an **AWS Nitro enclave** and returns the proof as
  a trailing `event: tee.proof` record on the response stream.
- The proof binds, by hash, **the exact request body and response body**, the upstream
  host and path, the HTTP method/status/content-type, and a nonce.
- The signing key is vouched for by a **COSE/P-384 attestation document** that chains to
  the AWS Nitro root certificate and reports the enclave's image measurement (PCR0).

The extension captures the raw bytes (pi's normal hooks cannot see them), verifies the
statement as the response streams, strips the proof record before pi's adapter sees it,
and reports the result. On every response it checks:

attestation chains to the pinned AWS Nitro root · certificate validity · enclave image
measurement (PCR0) equals your pinned value · signing key is the attested key · nonce
binding · Ed25519 statement over host/path/method/status/content-type · response body
hash · request body hash · upstream host · upstream path.

**What a green report establishes.** An enclave running the image whose measurement
equals your pinned `PCR0` established a real TLS connection to a party holding a valid
certificate for `chatgpt.com`, fetched exactly the bytes you received, and signed that
fact. Nothing in between could alter them.

**What it does not establish.** That OpenAI's own API served the model. The signed
upstream is a `chatgpt.com` TLS endpoint (the signed path is
`/backend-api/codex/responses`), not `api.openai.com`. OpenAI does not sign responses,
so the strongest available claim is "a valid `chatgpt.com` certificate was observed".
This ceiling is structural.

**Known gaps, deliberately not hidden:**

- **Request binding is unavailable.** wokey rewrites the request body before the enclave
  sees it, and no client-side serialization reproduces the rewrite, so the signed
  request hash commits to wokey's body, not yours. This is reported as a gap, not a
  failure. Prompt integrity is still covered indirectly: changing the prompt changes the
  signed hash, and the served model is read from the signed response body.
- **Headers and query strings are unsigned.** Model and thinking level live in the
  request body and are bound; a relay could still alter beta feature flags.
- **The nonce is relay-generated**, not a challenge you supply, so a genuine earlier
  exchange can be replayed within the certificate validity window.
- **Verification is per-exchange and local.** Only you, holding both byte strings, can
  check the content bindings.

## Trust anchors

Verification is only as strong as the values it is pinned to. There are three:

| Anchor | What it is | Trust |
|---|---|---|
| **AWS Nitro root** | The hardware root the attestation chains to, pinned by fingerprint in the verifier. | Hardware root. A compelled or broken Nitro service defeats it. |
| **Enclave image (PCR0)** | A hardcoded 96-hex-digit measurement of the audited enclave image. | **Operator-published.** Accepting the shipped value means trusting wokey's reproducible build. Replace it to remove that trust. |
| **Upstream identity** | The accepted signed host and path (`chatgpt.com`, `/backend-api/codex/responses`). | Measured from live proofs, not assumed. Any other route fails loudly. |

**Upgrading the PCR0 anchor.** The shipped `PUBLISHED_PCR0` comes from wokey's
reproducible-build document. To stop trusting the operator, build the enclave yourself
from the pinned revision and replace the constant in `config.ts`. Even without the full
build, pinning the value on day one and alerting on drift converts this into **change
detection** — the attack that actually matters, a quiet downgrade later rather than a
lie today.

The provider never reads a PCR0 from the proof itself. An unset anchor is reported as a
**failure**, not a pass, because model substitution would be unchecked.

If wokey ever changes upstream, the current host gate fails loudly. Widening it requires
one live proof from the new route; do not pre-approve a host from documentation alone.

## Configuration

Optional keys in `~/.pi/agent/wokey.json` (all optional; defaults shown):

| Key | Default | Purpose |
|---|---|---|
| `apiKey` | — | API key. Also mirrored to pi's credential store by `/wokey`. |
| `baseUrl` | `https://api.wokey.ai/v1` | Relay base URL. The bare `wokey.ai` host rejects API traffic. |
| `api` | `openai-responses` | Adapter. Use `openai-completions` if wokey only exposes `/v1/chat/completions`. |
| `expectedPcr0` | shipped constant | Your own pinned enclave measurement (96 hex digits). |
| `expectedHost` / `expectedHosts` | `chatgpt.com` | Accepted signed upstream host(s). Matching is exact, case-insensitive. |
| `expectedPaths` | `/backend-api/codex/responses` | Accepted signed upstream path(s). |
| `codexEnvelope` | `true` | Shape requests into the Codex envelope the upstream expects. |
| `verify` | `true` | Turn proof probing off entirely. |
| `notifyOnFailure` | `true` | Surface failed/unproven verdicts. |

Test-only environment overrides (unset in normal use): `WOKEY_EXPECTED_HOST`,
`WOKEY_EXPECTED_PCR0`, `WOKEY_EXPECTED_PATH`, `WOKEY_NO_VERIFY=1`.

## Troubleshooting

**Every response says `unproven`.** Nothing attested the response. Check what the relay
is actually sending:

```bash
curl -sN https://api.wokey.ai/v1/responses \
  -H "authorization: Bearer $WOKEY_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"hi","stream":true}' | tail -5
```

You should see a trailing `event: tee.proof`. If not, there is nothing to verify.

**`402 insufficient_balance` everywhere.** The key is fine — auth passed. The relay
bills before generating, so no response and no proof exist to check.

**`wrong_gateway_host`.** `baseUrl` is set to `wokey.ai` instead of `api.wokey.ai`.

**Request binding is always a gap.** Expected: wokey rewrites the request body, so the
signed request hash cannot match a client-side value. Everything else still verifies.

**Adapter errors.** wokey may only expose `/v1/chat/completions`. Set
`api: "openai-completions"` in `~/.pi/agent/wokey.json`.

## Vendored code

`verify/signing.ts`, `verify/verify-attestation-cose.mjs` and `verify/tee-verify-core.ts`
are vendored verbatim from
[focuxdot/proof-of-observation](https://github.com/focuxdot/proof-of-observation) at
commit `4bb11f36370ca5d574310882e0e6aff30c424287`. Upstream is dual-licensed MIT +
Apache-2.0; this distribution exercises the Apache-2.0 option for those files and
retains their headers unedited. See `LICENSE` and `NOTICE` for terms and attribution.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
