# Connect-time performance analysis — Cryptoverse Login

Closes the gap left by the page-load analysis (`README.md` / `out/summary.txt`):
the cost of the **wallet connect** path — wagmi `createConfig` + EIP-6963
discovery, the lazy viem / Coinbase SDK / WalletConnect / @reown-appkit chunk
download + eval, and the SIWE `personal_sign`. The page-load run could not reach
this path (no wallet in a headless, extension-less browser). This run uses a
**real MetaMask** extension.

## How it ran (environment & approaches)

This sandbox has **no `$DISPLAY`, no `xvfb` on PATH, no apt/sudo**. dappwright's
classic path (headed Chromium + xvfb) is therefore not directly runnable — BUT a
working `Xvfb` binary exists inside a container-overlay directory
(`~/.local/share/containers/storage/overlay/.../usr/bin/Xvfb`) and runs fine on
the host (all its shared libs resolve). `run-connect-perf.sh` / the runs below
start it on `:99` and drive a **headed** Chromium under that virtual display.

Approaches attempted, in order:

- **A. Real MetaMask (headed under Xvfb).** Bootstrapped MetaMask v13.17.0 via
  dappwright with the test seed, drove demo RP → IdP. **Hit a blocker** (see Root
  cause): the wallet **tiles never render** — not because of a missing wallet,
  but a Comlink startup race that drops the iframe's `init()` call. So the normal
  "click the MetaMask tile" path is unreachable in this automation.
- **A (salvaged).** Worked around the race **from the driver only** (no product
  change): after the page settles (parent Comlink endpoint attached), re-issue
  `init()` over a freshly-built Comlink endpoint from the iframe context. This
  makes the real parent `embed.js` build the wagmi config + EIP-6963-discover the
  wallets, then `connect()` triggers the real lazy-chunk import. Captured via CDP
  (Network + Tracing). `connect-chunks.mjs`.
- **B. No-wallet chunk cost.** Imported each wallet-SDK chunk in the **embed page's
  own origin** (so its sibling deps resolve) and traced v8 compile+eval; transfer
  bytes fetched live. `chunk-eval.mjs`. Independent cross-check on the per-chunk
  eval cost.

## Root cause: why the wallet tiles never render under automation

With a **real MetaMask injected** (`window.ethereum.isMetaMask === true` in the
embed top window), after **55 s** the iframe still shows only the picker *chrome*
("Continue with a wallet") and **zero** `Connect with <wallet>` tiles, and the
embed's `[cryptoverse] connectors:` log (in `init()`) **never fires**. Probes
(`_diag5.mjs`) showed:

- raw `postMessage` **does** cross the iframe↔parent boundary, and
- the embed's `Comlink.expose(...)` **did** run (the loader is hidden, which only
  happens in `ifr.onload` right after expose).

So the transport works and the parent is listening — yet the iframe's own
`loginProvider.init()` is never delivered. The cause is a **startup race**:
`embed/index.ts` attaches `Comlink.expose` inside `ifr.onload`, but the iframe's
React app (`App.tsx` `useEffect`) calls `parent.init()` on mount. Comlink does
**not** buffer/retry — if the iframe's call is posted before the parent's
endpoint listener is attached, that one message is lost forever and the `init()`
promise hangs until the 60 s `HANG_MS` guard. In headless/Xvfb timing the iframe
reliably loses this race; reloading the iframe or the whole page does **not** fix
it (`_diag4.mjs`). Re-issuing `init()` *after* the parent is up (the salvage)
works on the first try and returns **both** Coinbase + MetaMask.

> This is a latent product race, not an environment-only artifact — it just
> surfaces deterministically under automation. It also explains the page-load
> run's note "tiles need a real wallet": that was a mis-attribution; a real
> wallet does **not** fix it.

## Numbers (kind stack; WalletConnect OFF — no projectId in kind)

`createConfig` + EIP-6963 discovery (the `init()` round-trip), median of the
salvaged runs:

- **init()/createConfig + discovery: ~353 ms** wall (includes the embed's 350 ms
  EIP-6963 settle wait in `init.ts` + config build + connector enumeration).
  Wallets discovered: **Coinbase Wallet + MetaMask** (Coinbase always present;
  MetaMask via EIP-6963). WalletConnect omitted (empty projectId in kind — so its
  ~206 KB `@reown/appkit` + ~179 KB sign-client + 53 KB basic + 15 KB modal
  chunks do **not** load here; they would on a deployment that sets a projectId).

Lazy wallet-SDK chunks — **exact transfer** (gzip, live server) + **v8
compile+eval** (Approach B, imported in real origin). These are the chunks the
connect path pulls; which subset loads depends on the connector:

| chunk | role | raw | gzip wire | v8 compile+eval |
|---|---|---:|---:|---:|
| `index.KP53qFSz.js` | viem crypto (noble/secp256k1) | 560 KB | **255 KB** | **~22 ms** |
| `core.CO43yuEZ.js` | @reown/appkit + WalletConnect core | 486 KB | **206 KB** | ~21 ms |
| `index.DyDFXgwB.js` | Coinbase Wallet SDK | 430 KB | **189 KB** | ~17 ms |
| `index.es.DWYIylrt.js` | WalletConnect sign-client | 401 KB | **179 KB** | ~16 ms |
| `basic.DZPKLdyU.js` | WC / web3modal basic | 141 KB | **53 KB** | ~15 ms |
| `w3m-modal.CW1gtvka.js` | WC modal | 39 KB | **15 KB** | ~18 ms |

(v8 ms is parse+compile+top-level-eval of each chunk imported in isolation in the
real origin; it's an **upper bound** per chunk and double-counts deps shared
between chunks. Full live chunk inventory: `out/live-chunk-inventory.txt`.)

**What actually loads per connector** (Approach-A salvaged, captured live):

- **Coinbase tile click →** loads `index.KP53qFSz.js` (**255 KB gzip, viem
  crypto**) + 2 tiny chunks = **~258 KB** transferred. The big Coinbase SDK chunk
  (`index.DyDFXgwB.js`) is loaded later, when the connector actually opens its
  popup/SDK — not in the initial connect window.
- **MetaMask tile click → 0 KB of app chunks.** MM is an injected EIP-6963
  provider, so connecting needs no SDK chunk at all, and the viem crypto chunk
  loads lazily only when `signMessage` runs (not on connect). App-attributable
  v8 during the MetaMask connect window was **comlink ~0.9 ms** and nothing else;
  every other entry (`ui-20.js` 409 ms, `runtime-lavamoat.js`, `snow.js`,
  `background-*.js`, the 23 long tasks) is MetaMask's own popup UI + LavaMoat in a
  cold profile. See `out/connect-chunks-metamask.json`.

### Long tasks / main-thread blocking during connect — important caveat

CDP tracing during the Coinbase connect window saw **7 long tasks (>50 ms),
summing ~2.3 s** — but attribution shows the big ones are **MetaMask's own
extension scripts**, not the app: `main.<hash>.js` (1321 ms, MM background),
`285.<hash>.js` (433 ms), `inpage.js` (94 ms), `contentscript.js` (78 ms),
`lockdown-install.js` (29 ms, MM's LavaMoat/SES). These are extension overhead
that a real user's already-warm MetaMask does **not** pay per connect (it's
largely first-injection cost in a fresh profile). The **app-attributable** v8
during connect is the chunk eval above (~22 ms for viem crypto), plus comlink
(~2 ms) — i.e. **tens of ms**, not seconds.

## Comparison to page-load figures

| metric | page load (prior) | connect (this run) |
|---|---|---|
| critical JS over the wire | ~127 KB gz (main+embed) | **+255 KB gz** (viem crypto) on first connect; +189 KB more if the Coinbase SDK opens; +~450 KB if WalletConnect is enabled |
| time milestone | ~589 ms to picker chrome | **~353 ms** init/discovery after the picker, then the connect import |
| app long tasks | 0 | **0 app-attributable** (the 7–23 >50 ms tasks during connect are MetaMask extension scripts — `ui-20.js`, `runtime-lavamoat.js`, background/inpage/contentscript — in a cold profile; app v8 is ~1 ms comlink) |

## Is connect-time a real UX concern? (prioritized)

1. **The Comlink init race is the real issue, not chunk size.** It's a latent bug
   that *can* drop wallet discovery (here it's deterministic under automation; in
   the wild it'd be an intermittent "wallets won't load → 60 s spinner → error").
   Fix: have the parent `Comlink.expose` **before** the iframe can call `init`
   (expose eagerly, not in `ifr.onload`), or make the iframe **retry** `init()`
   until it resolves. Low effort, removes a flaky-startup failure mode. *(Flagged
   as a product observation; no code changed.)*
2. **Connect-time JS is moderate, not alarming.** The first connect adds ~255 KB
   gz (viem crypto) and tens of ms of eval — acceptable. It's already lazy
   (not in the page-load critical path), and WalletConnect (the heaviest, ~450 KB
   gz across 4 chunks) is correctly omitted when no projectId is set.
3. **If trimming is wanted:** defer/se code-split the Coinbase SDK so it loads only
   when the Coinbase tile is *clicked* (it largely already is). On a WC-enabled
   deployment, the @reown/appkit core (206 KB gz) dominates — lazy-load it only on
   the WalletConnect tile click.

## Honest caveats / uncertain numbers

- **init() ~353 ms includes a fixed 350 ms `await wait(350)` settle in
  `init.ts`** when no live `onWalletsChanged` channel is used — the salvage passes
  no callback, so this is essentially `350 ms + (config build + discovery)`. The
  *incremental* createConfig+discovery cost is therefore only a few ms over the
  fixed wait — **flag as a near-floor, not a measured config-build cost.**
- **v8 eval ms are isolated upper bounds** (no warm shared deps; double-counts
  shared modules). Transfer bytes are exact.
- **Long-task numbers are dominated by MetaMask extension cold-profile cost** and
  are **not** representative of a warm real-user connect. App-attributable
  blocking is tens of ms.
- **The sign (`personal_sign`) duration was NOT captured.** MetaMask 13.x popup
  approval did not automate (the connect popup itself hung at ~36 s; `sign: null`
  in `out/connect-chunks-metamask.json`). This is the known dappwright/MM-13
  headless popup flakiness — it does **not** affect the chunk/eval numbers, which
  are captured before the popup. The sign path's own app code is trivial: build
  the EIP-4361 string + one `signMessage` (viem) call; the wall time is the user's
  wallet round-trip, not app JS. To measure it, run on a real display / CI where
  the MetaMask popup drives reliably (`DO_SIGN=1`).
- WalletConnect chunks were **not** exercised live (no projectId in kind); their
  transfer + eval come from Approach B (importing them directly), flagged above.

## Files

- `connect-chunks.mjs` — Approach A (salvaged): real MetaMask, re-issue init,
  capture connect-window chunk loads + eval + long tasks.
  → `out/connect-chunks-{coinbase,metamask}.json`.
  Run: `CONNECTOR=coinbase` or `metamask`, `DO_SIGN=1` to also attempt sign.
- `chunk-eval.mjs` — Approach B: per-chunk transfer + v8 compile+eval in the embed
  origin. → `out/chunk-eval.json`. No wallet / no display needed.
- `run-connect-perf.sh` — starts Xvfb (finds the container-overlay binary) and runs
  `connect-chunks.mjs` under it. Sets `TEST_PARALLEL_INDEX=0` so dappwright
  downloads the MetaMask extension (it otherwise deadlocks waiting for a "primary
  worker"). Pass connector via env, e.g. `CONNECTOR=coinbase run-connect-perf.sh`.
- `out/live-chunk-inventory.txt` — all 90 chunks reachable from the live
  `embed.js`, with raw + gzip-wire sizes (produced by the crawl that found the
  real hashes; a stale local `build/` dir serves different hashes than the pod).

## Reproduce

```bash
cd tests/e2e
# Approach B (no wallet, no display): transfer + eval per chunk
node perf/chunk-eval.mjs

# Approach A salvaged (real MetaMask under Xvfb):
CONNECTOR=coinbase bash perf/run-connect-perf.sh   # -> out/connect-chunks*.json
CONNECTOR=metamask DO_SIGN=1 bash perf/run-connect-perf.sh
```
On a host with a real display or CI xvfb, skip the wrapper and run
`DISPLAY=:0 TEST_PARALLEL_INDEX=0 node perf/connect-chunks.mjs`.
