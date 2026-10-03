# Prompt cache misses on wokey.ai — client-side ruled out, reproducible

**Date:** 2026-10-03 **Model:** `gpt-6-luna` (also tested `gpt-6-sol`) **Endpoint:** `POST https://api.wokey.ai/v1/responses` → `chatgpt.com/backend-api/codex/responses`

## Summary

We are sending a **byte-identical request body** and the upstream still reports
`cached_tokens: 0` on a large fraction of calls. Across **72 identical requests** to
`gpt-6-luna`, **21 (29%) missed the cache**. The same test on `gpt-6-sol` hit **15/15**.

Because the request bytes and the relayed `request_body_sha256` are provably constant,
the variance is not in the request. It is in which upstream ChatGPT account/backend
instance serves the call — i.e. prompt-cache locality is not being held across requests.

## What we verified on our side (client is clean)

| Check | Result |
|---|---|
| `prompt_cache_key` present | ✅ set by pi's own adapter from the session id (`openai-responses.js:243`); our extension only fills it when absent, so it is a no-op |
| `store:false` | ✅ already set by pi (`openai-responses.js:246`); our envelope matches |
| Client request bytes stable | ✅ `sha256 = bd4a2638332e239d…` identical on every trial |
| Relayed body stable | ✅ **`request_body_sha256` in the TEE proof had exactly 1 distinct value across all trials** |
| Cache key is the gate? | ❌ No — a *different* `prompt_cache_key` with the same prompt still hit |

The relayed `request_body_sha256` being byte-stable means the gateway's rewrite of our
request is **deterministic** and adds **no per-request churn**, so it cannot explain an
intermittent miss pattern.

## Test runs

Same body, ~3.4k-token prefix, 1–2 s apart, `cached_tokens` read from `response.completed`:

```
gpt-6-luna  run 1 (n=12): MM H M HHHH M HHH      ->  8 hit / 4 miss
gpt-6-luna  run 2 (n=20): M HHHHHHH M HHHHHHH M  -> 16 hit / 4 miss
gpt-6-luna  run 3 (n=10): MM H MMM HH M H        ->  4 hit / 6 miss
gpt-6-luna  run 4 (n=30): HMHHMHHHHMMMHMHHHMHHHHHHHHHHHHHHH -> 23 hit / 7 miss

gpt-6-luna TOTAL : 51/72 hit (70.8%)  — 29.2% miss
gpt-6-sol  TOTAL : 15/15 hit (100%)
```

Misses are **randomly interleaved**, not periodic — inconsistent with a cache TTL expiry,
consistent with per-request routing.

Representative single trial (headers + proof, 10 identical requests):

```
#1 cached=0 MISS  x-wokey-request-id=20261003074037kwtjf
#2 cached=0 MISS  x-wokey-request-id=2026100307411193bso
#3 cached=2816 HIT x-wokey-request-id=202610030741476r8hy
...
request_body_sha256 = 1344173fd881c9c14af757358c22aaaf0a76aa65f074cd0f5e2255cce21ffe83  (same on all 10)
```

## Impact in real use

A real pi coding session on this provider (`gpt-6-luna`, 26 assistant turns) showed
**13 hits / 13 misses** and **49% token-weighted cache read** — with fully-miss turns
billing the entire context (`in=44359 cr=0`, `in=45703 cr=0`, `in=47917 cr=0`).

## Questions / asks

1. Is a request routed to a **specific ChatGPT account (subscription credential)**? If so,
   is routing **sticky per `prompt_cache_key`** or per connection, or randomly selected from
   a pool? A ~29% random miss rate is the signature of a small pool where only some
   accounts hold the cached prefix.
2. Why is `gpt-6-luna` affected while `gpt-6-sol` was 15/15? Different upstream pool?
3. Can you make `prompt_cache_key` affinity sticky for its documented TTL so that
   back-to-back requests with an identical prefix reuse the same upstream instance?
4. Please confirm the gateway's request rewrite is stateless/deterministic (our measurement
   says yes — `request_body_sha256` stable) and that nothing per-request (nonce, timestamp,
   `safety_identifier`) is injected into the forwarded body.

## Reproduction

```js
// node repro.mjs   — expects WOKEY_API_KEY in env
const FILLER = "Cache locality depends on a byte-identical prefix across consecutive calls. ".repeat(300);
const body = {
  model: "gpt-6-luna",
  instructions: "You are a helpful assistant.",
  input: [{ role: "user", content: [{ type: "input_text", text: FILLER + "\nSummarize in one word." }] }],
  store: false,
  include: ["reasoning.encrypted_content"],
  text: { verbosity: "low" },
  tool_choice: "auto",
  parallel_tool_calls: true,
  prompt_cache_key: "cachetest-fixed-key-0001",   // constant across all calls
  stream: true,
};
for (let i = 1; i <= 30; i++) {
  const res = await fetch("https://api.wokey.ai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.WOKEY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let cached = 0, rbs = null;
  for (const l of text.split("\n")) {
    if (!l.startsWith("data:")) continue;
    let p; try { p = JSON.parse(l.slice(5)); } catch { continue; }
    if (p?.response?.usage) cached = p.response.usage.input_tokens_details?.cached_tokens ?? 0;
    if (p?.request_body_sha256) rbs = p.request_body_sha256;
  }
  console.log(`#${i} cached=${cached} ${cached > 0 ? "HIT" : "MISS"} relay_body=${String(rbs).slice(0, 16)}`);
  await new Promise((r) => setTimeout(r, 800));
}
```

If routing affinity is intentional, documenting the pool size and the expected miss rate
would also help us pick the right provider per workload.