# Cryptoverse Login — page-load benchmark report (demo → wallet-picker interactive)

Measurement + analysis only. **No product code was changed**; this report
proposes optimizations, it does not implement them. Scripts live in
`tests/e2e/perf/`; raw + aggregate data under `tests/e2e/perf/out/` (gitignored).

## TL;DR

Against the live kind stack, with the now-FIXED Comlink handshake deployed, the
flow reaches the **first wallet tile (interactive picker)** in:

| cohort | time-to-first-tile (median) | p95 | n |
|---|---:|---:|---:|
| **WARM** (reused context/cache) | **336 ms** | 360 ms | 27 |
| **COLD** (fresh ctx, cache cleared+disabled) | **421 ms** | 442 ms | 27 |

Both cohorts rendered a tile in **28/28** iterations — zero failures, zero
main-thread long tasks. The flow is fast and stable on localhost. The single
biggest structural inefficiency is **cache**: WARM and COLD transfer almost the
same bytes (311 KB vs 315 KB/iter) because the static assets ship **no
`Cache-Control`**, so a returning visitor re-downloads everything (the main
bundle alone is 145 KB gz, fetched fresh on every load — 0/324 warm requests hit
cache).

---

## 1. Methodology

- **Driver:** `tests/e2e/perf/bench.mjs` — Playwright Chromium (headless) over
  CDP. For each iteration it: navigates the demo RP, clicks "Login with Ethereum
  Wallet", waits for the "Continue with a wallet" landing button inside the login
  iframe, **clicks it** (this mounts the React picker App and fires the
  iframe→parent Comlink `init()`), then polls until the first
  `aria-label^="Connect with "` tile is visible.
- **Cohorts (kept strictly separate):**
  - **WARM** — one browser context reused across all 28 iters (HTTP cache
    persists between iters).
  - **COLD** — a fresh context per iter + `Network.clearBrowserCache` +
    `Network.setCacheDisabled(true)` each iter.
- **Iterations:** 28 per cohort. **The first iter of each cohort was an outlier**
  (WARM 746 ms, COLD 621 ms — process/JIT warmup) and is **excluded** from the
  stats below (n=27). This is flagged in `out/bench-summary.txt`.
- **Per-iteration capture:** in-page `PerformanceObserver` (paint/LCP/longtask) +
  Navigation Timing in **every** frame (embed top doc + login SPA iframe), CDP
  `Performance.getMetrics`, the full Playwright network waterfall (sizes,
  content-encoding, cache-control, ETag/Last-Modified, `fromDiskCache`), and
  **custom Comlink-handshake instrumentation**: an init script wraps the
  `message` listener in every document to timestamp the `embed-ready` / `hello`
  markers, and latches the embed's `[cryptoverse] connectors:` `console.info`
  (which fires inside `init()` once the wagmi config is built + connectors
  enumerated).
- **Aggregation:** `tests/e2e/perf/bench-summarize.mjs` → median / mean / p95 /
  min / max / stddev / n per metric, phase breakdown, network + cache analysis.
  Outputs `out/bench-summary.txt` and `out/bench-aggregate.json`.

### Environment caveats — read the numbers with these in mind

- **Deployed build under test:** login image `localhost/cryptoverse-login/login:test`,
  image ID `sha256:8a166369…bce39d`, pod started `2026-06-22T22:04:34Z`
  (~10 h before the run). Static assets' `Last-Modified` is `Mon, 22 Jun 2026
  21:59:02 GMT` — this is the FIXED frontend (App chunk `App._Dd1y7hK.js`, main
  bundle `main.B4_lVWH_.js`). It is **behind** repo HEAD `18b30bc` (HEAD only adds
  the perf harness; no product change since the image was built).
- **Headless Chromium 149.0.7827.55**, single machine, localhost kind cluster.
  Network RTT to the cluster is ~0 — so **asset download time is essentially
  free here** (e.g. the 42 KB App chunk transfers in 3–4 ms). On real-world RTT
  the un-cached / un-preloaded assets cost full round-trips; the localhost
  numbers therefore *under-state* the network-bound opportunities (cache headers,
  preload) and *over-represent* the CPU/JS phases. **This is the most important
  caveat for prioritization.**
- **kind ≠ prod:** TLS is a local mkcert CA; HTTP/2 via ingress-nginx; no CDN; no
  real geographic latency. Prod would add CDN/edge caching (which makes the
  missing `Cache-Control` even more impactful) and real TLS/DNS.
- Numbers are wall-clock from `page.goto(demo)`. The `landing→click` gap (~70 ms)
  is **automation think-time** (the poll loop + Playwright click dispatch), **not**
  a real user delay — it is reported separately and excluded from the UX phases.

---

## 2. Distribution tables

All times in ms. n=27 (first iter excluded as warmup). Full tables (incl. CDP
metrics, per-doc TTFB/FCP/LCP/DCL/load) in `out/bench-summary.txt`.

### Key milestones (wall clock from demo navigation start)

**WARM**

| metric | median | mean | p95 | min | max | stddev |
|---|---:|---:|---:|---:|---:|---:|
| time-to-landing button | 211 | 212 | 228 | 195 | 238 | 9.1 |
| **time-to-first-tile** | **336** | 337 | 360 | 315 | 368 | 10.9 |
| post-click → tile delta | 53 | 53.5 | 60 | 45 | 71 | 4.4 |

**COLD**

| metric | median | mean | p95 | min | max | stddev |
|---|---:|---:|---:|---:|---:|---:|
| time-to-landing button | 301 | 303 | 321 | 282 | 365 | 16.3 |
| **time-to-first-tile** | **421** | 425 | 442 | 409 | 482 | 15.0 |
| post-click → tile delta | 53 | 53 | 55 | 47 | 55 | 1.8 |

### Per-document navigation / paint (in-page Navigation Timing, median)

| doc | metric | WARM | COLD |
|---|---|---:|---:|
| embed top doc (`/oauth2/auth`) | TTFB | 9.9 | 28.0 |
| | DCL / load | 36 | 54 |
| login SPA (`/login?…`) | TTFB | 6.5 | 6.4 |
| | **FCP / LCP** | **100** | **104** |
| | DCL / load | 47 | 55 |

> The SPA's FCP == LCP (~100 ms within the SPA frame's own clock) because the
> landing card is the largest contentful element and paints once the main bundle
> evaluates. The embed top doc reports no FCP/LCP (it's an empty shell hosting the
> iframe + `embed.js`; nothing paints in it).

### Comlink handshake + init/discovery (in-page perf.now markers, median)

| marker | WARM | COLD |
|---|---:|---:|
| login SPA receives `embed-ready` (since SPA origin) | 69 | 79 |
| embed receives first `hello` (since embed origin) | 207 | 224 |
| embed `[cryptoverse] connectors:` logged = init discovery done | 211 | 228 |
| connectors discovered per iter | 2 (Coinbase + injected fallback) | 2 |

### Main thread / CPU (CDP `Performance.getMetrics`, top page, median)

| metric | WARM | COLD |
|---|---:|---:|
| ScriptDuration | 68 ms | 72 ms |
| LayoutDuration | 18 ms | 18 ms |
| TaskDuration (total) | 158 ms | 159 ms |
| JSHeapUsedSize | 6.6 MB | 7.0 MB |
| **long tasks > 50 ms (all frames, all iters)** | **0** | **0** |

### Variance / outliers

Variance is low (stddev 9–16 ms on the headline metric). Causes of the residual
spread: process/JIT warmup (the excluded first iter), GC jitter, and ingress/TLS
scheduling on a shared host. **No long tasks** means no GC/JS stall is gating the
picker — the spread is sub-frame noise. COLD is tighter on the post-click delta
(sd 1.8) than WARM (sd 4.4), consistent with cache-disabled removing a
cache-lookup decision branch.

---

## 3. Phase breakdown — where the wall-clock to the interactive picker goes

Epoch-aligned across the embed and SPA frames (the embed doc starts ~37 ms after
the SPA frame; markers reconciled via `performance.timeOrigin`). The
**COLD median (421 ms)** decomposes roughly as:

| phase | ms (cold) | what happens | bound by |
|---|---:|---|---|
| demo RP + OAuth2 redirects → embed doc TTFB | ~120 | demo `/protected` → Django `/oidc/authenticate` 302 → Hydra `/oauth2/auth` → wrapper embed HTML. Several backend hops. | backend TTFB / redirect chain |
| embed doc load + `embed.js` fetch+eval | ~30 | 38 KB gz `embed.js` (wagmi/viem/wc/cb config builder) + sentry + comlink download & eval | JS eval (network ~free on localhost) |
| iframe → Hydra authorize → `/login` SPA | ~50 | iframe navigates `/oauth2/inner` → Hydra 302 → `/login`; SPA HTML (2.7 KB) + `main.B4_lVWH_.js` (145 KB gz) fetch | main-bundle download+eval |
| SPA FCP (landing card painted) | →~104 (SPA clock) | React mounts, landing card visible. **`Continue with a wallet` button is now clickable.** | main-bundle eval + first paint |
| *(user clicks "Continue")* | — | mounts the lazy `App` chunk under `{open && …}` | — |
| **post-click → first tile** | **~53** | lazy `App._Dd1y7hK.js` (42 KB gz) fetch+eval + React mount + Comlink `init()` round-trip + `listWallets()` | **App-chunk eval + React mount** (network ~3–4 ms here; a full RTT in prod) |

**Key attribution finding:** the embed's connector **discovery completes at
~211–228 ms (embed clock) — i.e. around the same moment the landing button
appears, BEFORE the user clicks.** The embed builds its wagmi config + enumerates
connectors eagerly while the user is still reading the landing card. So the
~53 ms the user waits *after* clicking "Continue" is **not** Comlink/discovery
cost — it is dominated by the **lazy `App` chunk eval + React mount**. The
Comlink handshake itself is cheap: `embed-ready` reaches the SPA at ~69–79 ms
into the SPA's life, well before the click.

DNS/TLS are negligible here (localhost, warm connections; embed TTFB 10 ms warm /
28 ms cold). The cold-vs-warm gap (+85 ms to first tile) is almost entirely the
**backend redirect chain + asset re-download** being un-cached, concentrated in
the demo→embed segment and the main-bundle fetch.

---

## 4. Network + cache analysis (the headline inefficiency)

| | WARM | COLD |
|---|---:|---:|
| total transfer / iter | 311 KB | 315 KB |
| login-spa (html+main+App+css+fonts) | 264 KB | 265 KB |
| embed-assets (embed.js+comlink+sentry) | 42 KB | 43 KB |

**WARM ≈ COLD.** Across **324 warm static-asset requests, 0 hit disk cache and 0
returned 304** — every asset is re-fetched as a full HTTP 200 with the complete
body on every iteration.

Root cause: the login `ServeDir` sends **`Last-Modified` only, no
`Cache-Control` and no `ETag`** (12 of 13 of our assets are "Last-Modified only";
1 has no validators). The server *does* honor `If-Modified-Since` (a manual
conditional GET returns `304`), but **without `Cache-Control` the browser treats
the freshly-navigated document's subresources as needing a fresh unconditional
fetch** — it doesn't even send the conditional request on these full
navigations. Result: a returning user pays the **full 264 KB** again.

Largest assets (gz over the wire), none with `Cache-Control`:

| KB gz | asset | role |
|---:|---|---|
| 145 | `main.B4_lVWH_.js` | React + MUI iframe app (the picker shell) |
| 47 | `inter-latin-wght-normal.woff2` | Inter variable font (latin subset) |
| 42 | `App._Dd1y7hK.js` | lazy picker App chunk (loaded on "Continue" click) |
| 38 | `embed.js` | top-window wagmi/viem/WC/CB config |
| 22 | `space-grotesk-latin…woff2` | display font (latin subset) |
| ~4 | `main.Dg3aR0yw.css` | app CSS |

Note: fonts use `font-display: swap` (✅ non-render-blocking) and the browser
correctly fetches **only the latin subset** of each (the cyrillic/greek/vietnamese
`@font-face` rules don't trigger fetches) — so there is **no runtime font
over-fetch**, contrary to a naive read of the multi-subset CSS.

---

## 5. Optimization opportunities — ranked by impact / effort

Each tied to evidence + a specific file. **Proposals only — not implemented.**

### #1 — Add `Cache-Control` (immutable) to the hashed static assets — HIGH impact, LOW effort

- **Evidence:** 0/324 warm requests cached; WARM transfer (311 KB) ≈ COLD
  (315 KB); 12/13 assets ship `Last-Modified` only, none have `Cache-Control`.
- **Where:** `login/login/src/main.rs:86` —
  `.fallback_service(ServeDir::new(&static_dir))` has no cache layer. The asset
  paths are content-hashed by Vite (`main.B4_lVWH_.js`, `App._Dd1y7hK.js`,
  `*.woff2`), so they are safe to mark
  `Cache-Control: public, max-age=31536000, immutable`. The non-hashed
  `embed.js` / `final.js` / `index.html` template should get a short
  `max-age` + revalidation instead (they keep stable names).
- **Benefit:** a returning user's transfer drops from ~264 KB to **~0** for the
  cached subset (and `immutable` skips even the revalidation RTT). On real RTT /
  via a CDN this removes one-or-more round-trips per asset from every repeat
  login — far larger than the ~5 ms it saves on localhost. **Biggest real-world
  win.**
- **Effort:** one `SetResponseHeaderLayer` (or a small `ServeDir` wrapper) keyed
  on path; a few lines.

### #2 — Preload / inline the lazy `App` chunk so it isn't a post-click round-trip — MEDIUM impact, LOW effort

- **Evidence:** the `App` chunk (42 KB gz) is loaded **only after** the "Continue
  with a wallet" click (`backgrounds/Default.tsx`: `{open && <Suspense><App/></Suspense>}`),
  and the `/login` SPA HTML has **no `modulepreload` for it** (only for
  `comlink` + `preload-helper`). The source's `webpackPreload: true` magic comment
  is a webpack hint that **Vite/Rollup ignore**, so no preload link is emitted.
  Here the fetch is 3–4 ms (localhost); on real RTT it is a **full round-trip the
  user waits through after committing to "Continue"** — i.e. the ~53 ms post-click
  delta becomes ~53 ms + 1 RTT in prod.
- **Where:** `login/login/frontend/src/backgrounds/Default.tsx` (the `lazy()`
  import) and/or the Vite build — add `<link rel="modulepreload">` for the App
  chunk in the index template, or warm the dynamic import during idle after the
  landing card paints (`requestIdleCallback(() => import("../App"))`), or simply
  fold the App into the main bundle (it's only 42 KB).
- **Benefit:** removes one post-click round-trip from the critical "I clicked,
  show me wallets" moment — the highest-intent part of the flow.
- **Effort:** a preload link or an idle-prefetch; low.

### #3 — Collapse the demo→embed redirect chain / backend TTFB — MEDIUM impact, MEDIUM effort

- **Evidence:** the demo→embed segment is the largest single phase (~120 ms
  cold). It is `demo /protected` → Django `/oidc/authenticate` 302 → Hydra
  `/oauth2/auth` → wrapper embed. Embed-doc TTFB alone is 10 ms warm / **28 ms
  cold**, and there are 3 sequential 30x hops before the embed HTML.
- **Where:** mostly the **demo RP** (out of the IdP's control) + Hydra authorize
  latency; the IdP-controllable part is the wrapper embed TTFB and the
  `/oauth2/inner` rewrite. Worth confirming Hydra isn't doing a cold DB hit per
  authorize.
- **Benefit:** shaving the redirect chain helps both cohorts uniformly.
- **Effort:** medium — touches Hydra config / the RP, harder to land safely;
  lower priority than #1/#2.

### #4 — Trim the 145 KB main bundle (MUI/emotion in the iframe) — MEDIUM impact, MEDIUM/HIGH effort

- **Evidence:** `main.B4_lVWH_.js` is 145 KB gz and is the single largest asset
  on the critical path to FCP (it must eval before the landing card paints; SPA
  FCP ~100 ms). It's React + MUI v7 on emotion for what is a one-card landing +
  a tile list.
- **Where:** `login/login/frontend/` bundle composition (MUI tree-shaking,
  emotion). Prior analysis already noted MUI dominates.
- **Benefit:** smaller main bundle → faster FCP and faster first tile in BOTH
  cohorts, and (with #1) a smaller first-visit cost. But MUI is load-bearing for
  the redesigned UI; trimming is real work with regression risk.
- **Effort:** medium-high. Lower priority than the near-free #1/#2.

### #5 — (Robustness, already fixed in the deployed image; keep) the Comlink handshake — N/A effort

- **Evidence:** with the deployed fix, **28/28** iters rendered a tile (vs the
  prior run where tiles never rendered under automation). The handshake
  (`embed-ready`/`hello`) resolves in ~69–79 ms and discovery finishes before the
  click. No action needed; noted so a future change doesn't regress it.

---

## 6. Numbers I'm unsure about / flagged

- **Post-click delta (~53 ms) is localhost-bound.** Network is ~free here (App
  chunk 3–4 ms). On real RTT this delta grows by ~1 RTT because the App chunk
  isn't preloaded (opportunity #2). **Treat 53 ms as a localhost floor, not a
  prod figure.**
- **`spa.firstTileAt` in-page marker is sometimes `undefined`** in the final
  frame snapshot (the SPA frame re-renders, dropping the MutationObserver mark).
  The authoritative tile time is the **wall-clock Playwright `isVisible` poll**
  (the headline `time-to-first-tile`), which is solid; the in-page mark was only a
  cross-check.
- **Embed vs SPA clock alignment** uses `performance.timeOrigin` (epoch). The
  ~37 ms embed-vs-SPA origin offset is measured per-iter, but the absolute
  alignment carries a few-ms uncertainty from when each document's origin was set.
  The qualitative conclusion (discovery completes ~at landing, before click) holds
  with margin.
- **`landing→click` ~70 ms is automation overhead**, not user time — excluded from
  UX phases but present in raw wall clock if you sum naively.
- **CDP `Performance.getMetrics` is cumulative for the top page only** (embed top
  doc); the iframe's CPU isn't in those totals. Long-task = 0 was measured across
  **all** frames via PerformanceObserver, so "no long tasks" is whole-flow.
- **Backend TTFB attribution in the phase table** is derived from the redirect
  chain + embed/SPA TTFB; the per-302-hop split is approximate (the demo RP and
  Hydra hops aren't separately instrumented here).

---

## 7. Reproduce

```bash
cd tests/e2e
node perf/bench.mjs --iters 28 --cohort warm --tag warm   # -> out/bench-warm.json
node perf/bench.mjs --iters 28 --cohort cold --tag cold   # -> out/bench-cold.json
node perf/bench-summarize.mjs                              # -> out/bench-summary.txt + bench-aggregate.json
```

Env: `DEMO_URL` / `LOGIN_URL` (default kind nip.io `:9443` hosts).

## Artifacts

- `out/bench-warm.json`, `out/bench-cold.json` — raw per-iteration data (network,
  framePerf, handshake markers, CDP metrics).
- `out/bench-summary.txt` — full distribution tables + per-doc nav + cache.
- `out/bench-aggregate.json` — machine-readable aggregate.
- `out/bench-{warm,cold}.log` — console logs of the runs.

**No product code was modified.** `git status` shows only the two new harness
scripts (`bench.mjs`, `bench-summarize.mjs`) and this report under
`tests/e2e/perf/`; all run data is under the gitignored `out/`.
