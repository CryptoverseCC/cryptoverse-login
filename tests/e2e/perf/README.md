# Live page-load performance analysis — Cryptoverse Login

Read-only performance harness. Drives a **real Chromium** (the Playwright-installed
build) through the live kind stack via the **Chrome DevTools Protocol** and
captures navigation/paint, the network waterfall, JS/CSS coverage, and the
main-thread breakdown up to the rendered wallet-picker.

> This measures **page-load / render** performance only (demo RP → embed →
> iframe picker chrome). It deliberately does **not** drive the wallet
> connect/sign path — that needs the dappwright / real-wallet suite (see
> `tests/e2e/specs`). In a headless, extension-less browser the iframe→parent
> Comlink `init()` round-trip + wagmi connector discovery does not complete, so
> the `Connect with <wallet>` **tiles** never render; the picker **chrome**
> ("Continue with a wallet") does, and that is the milestone measured.

## Run

```bash
cd tests/e2e
node perf/perf.mjs --iters 5            # warm: writes out/perf-warm.json
node perf/perf.mjs --iters 3 --cold     # cold (cache cleared): out/perf-cold.json
node perf/summarize.mjs                 # medians + tables -> out/summary.txt
node perf/trace.mjs                     # one CDP timeline trace -> out/trace-summary.txt
```

Env: `DEMO_URL` / `LOGIN_URL` (default the kind nip.io `:9443` hosts).

## What each script collects

- `perf.mjs` — per iteration: PerformanceObserver paint/LCP/longtask + navigation
  timing in **every** frame (top + embed + login iframe), CDP `Performance.getMetrics`,
  the full network waterfall (sizes, content-encoding, cache-control, MIME, timing),
  and `page.coverage` JS+CSS used/total. Detects two render milestones:
  `time-to-picker-chrome` (primary) and `time-to-wallet-tile` (needs a wallet).
- `summarize.mjs` — folds the raw JSON into median tables (milestones, per-doc
  nav/paint, network transfer per document, largest assets, compression gaps,
  worst unused-code offenders, long tasks / approx TBT).
- `trace.mjs` — one CDP `Tracing` capture (devtools.timeline + v8) summarised into
  main-thread time by activity and script-eval time per file.

## Headline findings (see out/summary.txt + out/trace-summary.txt)

- Time-to-picker-chrome: **~590ms warm / ~620ms cold** (median). Cold≈warm because
  the hashed assets ship **no `Cache-Control`** (only `Last-Modified`) — the browser
  revalidates instead of serving from cache. Fix in `login/login/src/main.rs:86`
  (the `ServeDir` has no cache-control layer).
- Initial page-load transfer ≈ **272KB** over the wire; biggest: `main.CDHTzSdw.js`
  147KB gz (React+MUI iframe app), fonts inter+space-grotesk 71KB, `embed.js` 38KB gz.
- Main thread is light during load: **~250ms total RunTask, zero tasks >50ms** — the
  heavy crypto libs (Coinbase SDK / WalletConnect / Reown AppKit / viem, ~1.9MB raw
  across lazy chunks) are dynamically imported only at **connect** time, not on load.
  Their eval cost is therefore NOT in these page-load numbers (flagged in the report).
