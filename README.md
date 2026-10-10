# pi-wokey

A [pi](https://pi.dev) provider for [wokey.ai](https://wokey.ai)'s GPT and Claude models that
checks every response against wokey's TEE proof and tells you when a reply cannot be proven.

## What's included

| Extension | Command / shortcut | What it does |
|---|---|---|
| `index.ts` | provider `wokey` | Registers the wokey lineup with pi. Routing, thinking levels, prompt caching and usage accounting run through pi's native adapters. |
| `index.ts` | `/wokey` | Management menu (status, models). |
| `index.ts` | `/wokey status` | Only changing or attention-worthy information: timestamped cards for failed exchanges (paged when there are more than three), the latest exchange summary, account balance, and conditional verification warnings. |
| `index.ts` | `/wokey models` | Picks which models are registered with pi. Vendor tabs, rates, context window and thinking levels per row. |
| `index.ts` | `session_start` hook | Reports readiness and refreshes the model catalog from wokey. |

No shortcuts, tools or CLI flags. `/wokey key`, `unset` and `clear` are retired and only
point at pi's own credential commands.

## Install

```bash
pi install npm:pi-wokey
```

Other sources:

```bash
pi install git:github.com/kslamph/pi-wokey
pi install ./pi-wokey               # local clone
```

Try it without installing anything:

```bash
pi -e npm:pi-wokey
```

After installing, store your wokey API key and pick a model:

```text
/login wokey        # key goes into pi's credential store
/model wokey        # select a wokey model
```

## Usage

Ask for anything you normally would. Verification runs on every response and stays quiet
unless something is wrong.

![wokey.ai panels: model selector with vendor tabs, status with a clean session, a failed verification, and a paged error log](docs/wokey-demo.gif)

```text
/wokey status       # any verification errors this session, and your balance
/wokey models       # add or remove models
```

Four models are registered by default:

| Model id | Vendor | Route | Proof |
|---|---|---|---|
| `gpt-6.1-sol` | OpenAI | Codex Responses | verified |
| `gpt-6-luna` | OpenAI | Codex Responses | verified |
| `gpt-6-astra` | OpenAI | Codex Responses | verified |
| `claude-opus-5-5` | Anthropic | Anthropic Messages | verified |

Additional GPT and Claude models, plus the Zhipu / MiniMax / DeepSeek chat models, are
available in `/wokey models`. The chat models are opt-in because wokey publishes proofs
for the official Codex Responses and Anthropic Messages routes only — their exchanges are
recorded as unattested by design and never warn.

## Configuration

Credentials are pi-managed: run `/login wokey` (and `/logout wokey` to remove the key).
This extension stores no key of its own and deliberately does not read `WOKEY_API_KEY`.

Everything else is optional, in `~/.pi/agent/wokey.json` (defaults shown):

| Key | Default | Purpose |
|---|---|---|
| `verify` | `true` | Probe every response. `false` turns verification off entirely. |
| `notifyOnFailure` | `true` | Warn on a failed check, and once per session on an unattested response. |
| `expectedPcr0` | shipped constant | Your own pinned enclave measurement (96 hex digits). |
| `enabledModels` | verified lineup | Model ids registered with pi, set by `/wokey models`. Unknown ids are ignored. |

Environment variables: `WOKEY_CONFIG` overrides the settings file path.
`WOKEY_NO_VERIFY=1` and `WOKEY_EXPECTED_PCR0=<hex>` are test overrides and are not needed
in normal use.

## Security

- **Network.** Model traffic and the catalog go to `https://api.wokey.ai` only:
  the route base URLs, `GET /v1/models` for the catalog, and `GET /v1/dashboard/balance`
  when you open `/wokey status`. No other host is contacted. Proof verification is local
  arithmetic — a P-384 certificate check, an Ed25519 statement check and a SHA-256 body
  hash — with no extra round-trip.
- **Files.** Reads and writes `~/.pi/agent/wokey.json` only. No shell commands, no child
  processes, and nothing read from the current directory or a project `.env`.
- **Permissions.** Like any pi extension it runs in-process with your user's OS permissions.
- **What a green verdict means.** An enclave running the pinned image fetched these exact
  bytes from a genuine upstream TLS endpoint. It cannot prove that OpenAI or Anthropic
  served the model you asked for, because neither signs its responses.
- **What `/wokey status` shows.** Only what is new: a card for every exchange that
  failed verification (paged past three), the last exchange's model, size, latency and
  verdict, and your balance. Pinned trust anchors, the measured upstream tuples, the
  accepted limits and the full check roster are static, so they are documented here
  rather than reprinted on every open. Two conditions are worth watching and are shown
  inline when they occur: `verification is OFF`, and `no audit PCR0 is pinned`.

## Update, remove, disable

```bash
pi update --extensions        # update all installed packages
pi update npm:pi-wokey        # update just this one
pi remove npm:pi-wokey        # uninstall
pi config                     # enable or disable the package's resources
```

## Compatibility

- Pi 1.0.2. `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` are supplied by pi (`peerDependencies`), not bundled.
- Node.js 22 or newer (`engines` in `package.json`).
- Developed and tested on Linux. macOS and Windows: TODO: confirm.

## Development

```bash
git clone https://github.com/kslamph/pi-wokey
cd pi-wokey
npm install
npm test            # vitest run
npm run typecheck   # tsc --noEmit
pi -e ./index.ts    # load the working copy for one run
```

A local install (`pi install ./pi-wokey`) is loaded in place, not copied, so
edits take effect on the next start. Run `npm install` first — pi does not install
dependencies for local packages.

## License and credits

Apache-2.0. See `LICENSE` and `NOTICE`.

Unofficial: an independent integration by a wokey subscriber, with no affiliation with or
endorsement from wokey.ai. `verify/signing.ts`, `verify/verify-attestation-cose.mjs` and
`verify/tee-verify-core.ts` are vendored from
[focuxdot/proof-of-observation](https://github.com/focuxdot/proof-of-observation) at
`4bb11f36370ca5d574310882e0e6aff30c424287` (dual MIT / Apache-2.0; Apache-2.0 exercised
here).
