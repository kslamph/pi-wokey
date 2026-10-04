# pi-wokey

**Use [wokey.ai](https://wokey.ai)'s GPT models without having to take them on faith.**

Every relay that sits between you and a model is a middleman. This extension is a 
[pi](https://pi.dev) provider that cryptographically checks every single response
against wokey's TEE attestation, then tells you plainly — in one word — whether that
response can be proven.

- You keep using the model exactly as you normally would.
- Verification runs **silently in the background on every request**.
- It costs **about a millisecond** of local CPU, no extra network round-trip, and
  nothing added to your bill.
- If a response can't be proven, you find out. Nothing is silently swallowed.

> **Cost in one line:** ~1 ms per response, versus seconds of model latency.
> Measured with Node 24 on the primitives involved: P-384 certificate check 0.55 ms,
> Ed25519 statement check 0.09 ms, SHA-256 body hashing 0.02 ms. It is pure local
> arithmetic — your request is sent once, exactly as before, and the check happens
> while the reply streams back.

---

## Contents

- [Install](#install)
- [Usage](#usage)
- [What you get](#what-you-get)
- [Reading the verdict](#reading-the-verdict)
- [Models](#models)
- [How the verification works](#how-the-verification-works)
- [What "verified" does and doesn't mean](#what-verified-does-and-doesnt-mean)
- [Trust anchors](#trust-anchors)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Vendored code](#vendored-code)
- [Scope and contributions](#scope-and-contributions)
- [License](#license)

---

## Install

```bash
pi install npm:pi-wokey
```

That is the whole installation. Restart pi, or start a new session, and the `wokey`
provider is available with the models listed below.

## Usage

There is nothing to do. Pick `wokey` as your provider, choose a model, and work.

When you want to look under the hood, type `/wokey`. It opens a menu — arrow keys to
move, enter to pick, esc to cancel — and it loops, so you can do several things in one
visit:

![wokey TUI: the /wokey menu, the live model lineup, a verified exchange, then a failed one](docs/wokey-demo.gif)

*The `/wokey` panels — a verified exchange, folded and unfolded with `m`, then a failed
one (warn-only). Illustrative data.*

| Menu item | What it shows you |
|---|---|
| **Status** | How much balance you have left, the verdict counters, your masked key and which store it came from, and the last exchange with every individual check. Press `m` to fold out the trust details — the pinned image measurement, the expected upstream, and the probing and settings state. Press `r` to refresh. |
| **Models** | The lineup with current rates, context window, and the exact thinking levels each model supports. |
| **Set API key** | Prompts for a key and writes both stores. |
| **Unset API key** | Confirms, then removes the key from both stores. |

In a headless run (`pi -p`, or no UI) the subcommands print instead of opening a panel:

```bash
/wokey status          /wokey models
/wokey key <value>     /wokey unset
```

Give pi your wokey key with `/wokey key sk-your-key-here` — it writes
`~/.pi/agent/wokey.json` (mode `600`) and mirrors it into pi's own credential store.
Prefer not to paste a key into a chat? Write that file yourself, or export
`WOKEY_API_KEY`; both are picked up automatically. See [Configuration](#configuration)
for where keys are looked up and what else you can change.

## What you get

| | |
|---|---|
| **Three GPT-6 models** | `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, with wokey's live context limits and thinking levels. |
| **Verified every response** | Each reply carries a signed proof from the enclave that produced it. This extension checks it and labels the exchange. |
| **Warn-only, never blocking** | A failed or missing proof is reported, but your reply is always delivered. A relay outage degrades into a notice, not a dead session. |
| **Silent by default** | No popups, no prompts, no flags to set. `/wokey status` is there when you want the detail. |
| **Live catalog sync** | Context windows and rates are re-read from wokey on every startup, so the numbers you see are current. |
| **Balance at a glance** | `/wokey` reads what you have left to spend from wokey when you open it, so you never have to leave the terminal to check. |
| **Native TUI panels** | `/wokey` renders as real pi panels, not a wall of text. |

## Reading the verdict

Every exchange gets exactly one of four labels.

| Verdict | What it means |
|---|---|
| ✅ `verified` | Every check passed. |
| 🟡 `verified-with-gaps` | Everything achievable passed, but one structural check is unavailable (currently request binding — see [below](#known-gaps-deliberately-not-hidden)). Shown in `/wokey`, not warned on every turn. |
| ❌ `failed` | Attestation, signature, hashes, or the upstream host/path did not match. Treat the response as untrusted. |
| ⚠️ `unproven` | No proof record was present, so there was nothing to verify. |

`/wokey` shows the running counters, your remaining balance, and the full check list for
the last exchange. In the TUI, anything that is not `verified` is raised as a styled session
warning (yellow, above the editor); in a headless run — `pi -p`, `--json`, RPC — it is written
to stderr instead, so you see it even with no UI to draw in:

```
[wokey] ❌ wokey verification failed — Response signature: received bytes do not match the signed hash — response was modified
[wokey] ⚠️ wokey response is not attested — Proof present: no tee.proof in the response — nothing was attested
```

## Models

| Model | Thinking levels |
|---|---|
| `gpt-6.1-sol` | low, medium, high, xhigh, max |
| `gpt-6-luna` | off, low, medium, high, xhigh, max |
| `gpt-6-astra` | low, medium, high, xhigh, max |

`gpt-6.1-sol` and `gpt-6-astra` cannot disable reasoning — asking for `off` is clamped
up to `low`. Only `gpt-6-luna` supports turning it off. These levels come from OpenAI's
model cards rather than from probing the relay, because the gateway happily accepts
efforts the models themselves do not support.

**Prices change, so this README does not list them.** wokey uses dynamic pricing with
peak and off-peak rates. Context limits and rates are re-read from wokey on every
startup; the current numbers for your lineup are in `/wokey` → **Models**, and on
wokey's site at <https://wokey.ai/models>.

## How the verification works

No background service, no extra API call, no telemetry. Alongside the model output,
wokey returns a **Proof-of-Observation**: a statement signed by the enclave that handled
your request, plus the attestation document that proves what that enclave is.

- wokey runs the upstream call inside an **AWS Nitro enclave** and returns the proof as
  a trailing `event: tee.proof` record on the response stream.
- The proof binds, by hash, **the exact request body and response body**, the upstream
  host and path, the HTTP method, status and content-type, and a nonce.
- The signing key is vouched for by a **COSE/P-384 attestation document** that chains to
  the AWS Nitro root certificate and reports the enclave's image measurement (PCR0).

The extension captures the raw bytes as they stream past (pi's normal hooks cannot see
them), verifies the statement, removes the proof record before pi's adapter sees it, and
records the verdict. On every response it checks:

```
attestation chains to the pinned AWS Nitro root · certificate validity ·
enclave image measurement (PCR0) equals your pinned value · signing key is the
attested key · nonce binding · Ed25519 statement over host/path/method/status/
content-type · response body hash · request body hash · upstream host · upstream path
```

All of that is hashing and signature verification — the reason it costs about a
millisecond rather than a round-trip.

## What "verified" does and doesn't mean

### What a green report establishes

An enclave running the image whose measurement equals your pinned `PCR0` opened a real
TLS connection to a party holding a valid certificate for `chatgpt.com`, fetched exactly
the bytes you received, and signed that fact. Nothing in between could have altered
them.

### What it does not establish

That OpenAI's own API served the model. The signed upstream is a `chatgpt.com` TLS
endpoint (the signed path is `/backend-api/codex/responses`), not `api.openai.com`.
OpenAI does not sign responses, so the strongest available claim is "a valid
`chatgpt.com` certificate was observed". This ceiling is structural, not a gap in the
implementation.

### Known gaps, deliberately not hidden

- **Request binding is unavailable.** wokey rewrites the request body before the enclave
  sees it, and no client-side serialization reproduces that rewrite, so the signed
  request hash commits to wokey's body rather than yours. This is reported as a gap,
  not a failure. Prompt integrity is still covered indirectly: changing the prompt
  changes the signed hash, and the served model is read from the signed response body.
- **Headers and query strings are unsigned.** Model and thinking level live in the
  request body and are bound, so a relay could still alter beta feature flags.
- **The nonce is relay-generated**, not a challenge you supply, so a genuine earlier
  exchange could in principle be replayed inside the certificate validity window.
- **Verification is per-exchange and local.** Only you, holding both byte strings, can
  check the content bindings.

## Trust anchors

Verification is only as strong as the values it is pinned to. There are three:

| Anchor | What it is | What you are trusting |
|---|---|---|
| **AWS Nitro root** | The hardware root the attestation chains to, pinned by fingerprint in the verifier. | Hardware. A compelled or broken Nitro service defeats it. |
| **Enclave image (PCR0)** | A hardcoded 96-hex-digit measurement of the audited enclave image. | **Operator-published.** Accepting the shipped value means trusting wokey's reproducible build. Replace it to remove that trust. |
| **Upstream identity** | The accepted signed host and path (`chatgpt.com`, `/backend-api/codex/responses`). | Measured from live proofs, not assumed. Any other route fails loudly. |

**Upgrading the PCR0 anchor.** The shipped `PUBLISHED_PCR0` comes from wokey's
reproducible-build document. To stop trusting the operator, build the enclave yourself
from the pinned revision and replace the constant in `config.ts`. Even without the full
build, pinning the value on day one and alerting on drift turns this into **change
detection** — which is the attack that actually matters: a quiet downgrade later rather
than a lie today.

The provider never reads a PCR0 out of the proof itself. An unset anchor is reported as
a **failure**, not a pass, because model substitution would otherwise go unchecked.

If wokey ever changes upstream, the host gate fails loudly. Widening it requires one
live proof from the new route — never pre-approve a host from documentation alone.

## Configuration

Everything is optional. Add keys to `~/.pi/agent/wokey.json` (defaults shown):

Keys are looked up in this order: `~/.pi/agent/wokey.json` → pi's credential store
(`auth.json`, entry `wokey`) → the `WOKEY_API_KEY` environment variable.

| Key | Default | Purpose |
|---|---|---|
| `apiKey` | — | Your API key. Also mirrored to pi's credential store by `/wokey key`. |
| `baseUrl` | `https://api.wokey.ai/v1` | Relay base URL. The bare `wokey.ai` host rejects API traffic. |
| `api` | `openai-responses` | Adapter. Use `openai-completions` if wokey only exposes `/v1/chat/completions`. |
| `expectedPcr0` | shipped constant | Your own pinned enclave measurement (96 hex digits). |
| `expectedHost` / `expectedHosts` | `chatgpt.com` | Accepted signed upstream host(s). Matching is exact, case-insensitive. |
| `expectedPaths` | `/backend-api/codex/responses` | Accepted signed upstream path(s). |
| `codexEnvelope` | `true` | Shape requests into the Codex envelope the upstream expects. |
| `verify` | `true` | Turn proof probing off entirely. |
| `notifyOnFailure` | `true` | Surface failed verdicts, and the first `unproven` one per session. |

Test-only environment overrides (unset in normal use): `WOKEY_EXPECTED_HOST`,
`WOKEY_EXPECTED_PCR0`, `WOKEY_EXPECTED_PATH`, `WOKEY_NO_VERIFY=1`.

## Troubleshooting

**Every response says `unproven`.** Nothing attested the response. Look at what the
relay is actually sending:

```bash
curl -sN https://api.wokey.ai/v1/responses \
  -H "authorization: Bearer $WOKEY_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"hi","stream":true}' | tail -5
```

You should see a trailing `event: tee.proof`. If there is none, there is nothing to
verify.

**`402 insufficient_balance` everywhere.** Your key is fine — authentication passed.
The relay bills before it generates, so no response and no proof ever exist to check.

**The balance line shows `—`.** The balance could not be read: no key is set, the relay
did not answer in time, or the reply was not one. Everything else in the panel still
works, and `r` tries again.

**`wrong_gateway_host`.** `baseUrl` is set to `wokey.ai` instead of `api.wokey.ai`.

**Request binding is always a gap.** Expected. wokey rewrites the request body, so the
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

## Scope and contributions

This project is a personal, independent integration built by one wokey subscriber. It
carries no affiliation with, endorsement from, or partnership with wokey.ai, and it uses
the wokey service strictly as an ordinary paying user.

The wokey platform fronts several upstream providers and offers a wider model catalog
than this extension currently covers. The integration is deliberately scoped to the three
models in daily personal use, so no other provider or model is wired in on purpose.

That scope is a starting point rather than a ceiling. Contributions from other developers
that add further providers or models are welcome: please include tests for the new
coverage and open a pull request. Such changes will be reviewed and merged, so the
extension can serve a broader user base.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
