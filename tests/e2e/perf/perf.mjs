// @ts-check
/**
 * LIVE performance analysis of the Cryptoverse Login flow against the running
 * kind stack. Read-only: drives a real Chromium (the Playwright-installed build)
 * via the Chrome DevTools Protocol and captures, per iteration:
 *
 *  - Navigation & paint timings (PerformanceObserver in-page + CDP Performance.getMetrics)
 *  - Full network waterfall (CDP Network domain: sizes, compression, timing, MIME)
 *  - JS/CSS coverage (Playwright page.coverage = CDP Profiler/CSS rule tracking)
 *  - Main-thread long tasks + an approximate Total Blocking Time
 *
 * The flow is a 3-document chain:
 *   demo RP  --click-->  /oauth2/auth (wrapper embed, loads embed.js)
 *            --iframe-->  /oauth2/inner == Hydra authorize
 *            --302----->  /login?login_challenge=... (React main bundle, picker)
 *
 * We attribute network cost per top-level document by frame URL, and treat the
 * "wallet picker rendered" signal as the first `Connect with <name>` tile
 * appearing inside the login iframe.
 *
 * Usage:
 *   node perf.mjs --iters 5            # 5 warm iters (default 5)
 *   node perf.mjs --iters 3 --cold     # clear cache before each iter
 *
 * Env overrides: DEMO_URL, LOGIN_URL (default nip.io :9443 hosts).
 */

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
mkdirSync(OUT_DIR, { recursive: true });

const DEMO_URL = process.env.DEMO_URL ?? "https://login-demo.cv.127.0.0.1.nip.io:9443";
const LOGIN_URL = process.env.LOGIN_URL ?? "https://login.cv.127.0.0.1.nip.io:9443";

const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const ITERS = Number(flag("iters", 5));
const COLD = !!flag("cold", false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify a request URL into one of the three documents of the flow. */
function docOf(url) {
  if (!url) return "other";
  if (url.includes("login-demo.cv.127.0.0.1.nip.io") || url.startsWith(DEMO_URL))
    return "demo";
  // login host serves BOTH the wrapper embed page AND the /login SPA + assets.
  // Split by path so embed.js (top window) vs the React main bundle (iframe)
  // are attributed separately.
  if (url.includes("/oauth2/")) return "embed-doc"; // wrapper embed html + hydra authorize
  if (url.includes("login.cv.127.0.0.1.nip.io") || url.startsWith(LOGIN_URL))
    return "login-assets"; // SPA html/js/css/img served under /login/
  return "other";
}

/** Finer asset bucket for the big-asset table. */
function assetBucket(url) {
  const u = url.toLowerCase();
  if (u.includes("embed.js")) return "embed.js (top window, wagmi/viem/wc/cb)";
  if (u.includes("final.js")) return "final.js";
  if (u.includes("/static/js/") && u.endsWith(".js")) return "main bundle (chunk)";
  if (u.endsWith(".css")) return "css";
  if (u.includes("sentry")) return "sentry";
  return "other";
}

async function runIteration(browser, idx, cold) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // --- CDP session for the top-level page (network + perf metrics + tracing) ---
  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Performance.enable", { timeDomain: "timeTicks" }).catch(() => {});
  if (cold) {
    await client.send("Network.clearBrowserCache");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  }

  // Collect network events across ALL frames/targets. We attach to every target
  // so the iframe's (Hydra authorize, /login) requests are captured too.
  /** @type {Map<string, any>} */
  const requests = new Map();
  /** @type {any[]} */
  const finished = [];

  const wireNetwork = (sess, targetLabel) => {
    sess.on("Network.requestWillBeSent", (e) => {
      requests.set(e.requestId + "@" + targetLabel, {
        requestId: e.requestId,
        target: targetLabel,
        url: e.request.url,
        method: e.request.method,
        type: e.type,
        startTs: e.timestamp,
        wallTime: e.wallTime,
      });
    });
    sess.on("Network.responseReceived", (e) => {
      const r = requests.get(e.requestId + "@" + targetLabel);
      if (!r) return;
      r.status = e.response.status;
      r.mimeType = e.response.mimeType;
      r.protocol = e.response.protocol;
      r.fromCache = e.response.fromDiskCache || e.response.fromPrefetchCache;
      const h = {};
      for (const [k, v] of Object.entries(e.response.headers || {}))
        h[k.toLowerCase()] = v;
      r.contentEncoding = h["content-encoding"] || "";
      r.contentLength = h["content-length"] || "";
      r.cacheControl = h["cache-control"] || "";
      r.timing = e.response.timing || null;
      r.respType = e.type;
    });
    sess.on("Network.loadingFinished", (e) => {
      const r = requests.get(e.requestId + "@" + targetLabel);
      if (!r) return;
      r.encodedDataLength = e.encodedDataLength; // bytes over the wire (incl headers)
      r.finishTs = e.timestamp;
      finished.push(r);
    });
    sess.on("Network.loadingFailed", (e) => {
      const r = requests.get(e.requestId + "@" + targetLabel);
      if (!r) return;
      r.failed = true;
      r.errorText = e.errorText;
    });
  };
  wireNetwork(client, "top");

  // Auto-attach to OOPIFs / iframes so we capture iframe network too.
  await client.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  client.on("Target.attachedToTarget", async (e) => {
    try {
      const sess = /** @type {any} */ (client).connection
        ? null
        : null;
    } catch {}
  });

  // Playwright's own per-target CDP isn't exposed for child frames easily, so we
  // ALSO collect network at the Playwright level (works across frames) as the
  // authoritative source for transfer sizes via response.body() sizes + headers.
  /** @type {any[]} */
  const pwRequests = [];
  page.on("requestfinished", async (req) => {
    try {
      const resp = await req.response();
      if (!resp) return;
      const timing = req.timing();
      const sizes = await req.sizes().catch(() => ({}));
      const headers = await resp.allHeaders().catch(() => ({}));
      pwRequests.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: resp.status(),
        frameUrl: req.frame()?.url() ?? "",
        fromServiceWorker: resp.fromServiceWorker?.() ?? false,
        // sizes: requestBodySize, requestHeadersSize, responseBodySize, responseHeadersSize
        ...sizes,
        contentEncoding: (headers["content-encoding"] || "").toLowerCase(),
        contentType: headers["content-type"] || "",
        cacheControl: headers["cache-control"] || "",
        contentLength: headers["content-length"] || "",
        timing,
      });
    } catch {}
  });

  // --- Start JS + CSS coverage (CDP Profiler.startPreciseCoverage + CSS tracking) ---
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });

  // --- Inject a perf collector into EVERY document (top + iframes) ---
  // Captures paint/LCP/navigation/longtask entries from the page's own
  // PerformanceObserver, plus a marker for when the wallet picker tile appears.
  await context.addInitScript(() => {
    // @ts-nocheck
    const w = /** @type {any} */ (window);
    w.__perf = {
      url: location.href,
      paints: [],
      lcp: 0,
      longtasks: [],
      nav: null,
      pickerRenderedAt: null,
      observerStart: performance.now(),
    };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__perf.paints.push({ name: e.name, startTime: e.startTime });
      }).observe({ type: "paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        const es = list.getEntries();
        const last = es[es.length - 1];
        if (last) w.__perf.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          w.__perf.longtasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {}
    // Watch for the first wallet tile (aria-label="Connect with ...") rendering.
    try {
      const mo = new MutationObserver(() => {
        if (w.__perf.pickerRenderedAt) return;
        const el = document.querySelector('[aria-label^="Connect with "]');
        if (el) {
          w.__perf.pickerRenderedAt = performance.now();
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
  });

  // ----------------------------------------------------------------------------
  // DRIVE THE FLOW
  // ----------------------------------------------------------------------------
  const t0 = Date.now();
  await page.goto(DEMO_URL + "/", { waitUntil: "load" });

  // Click the demo login button -> redirect to /oauth2/auth (embed page).
  await page.getByText("Login with Ethereum Wallet").click();

  // Wait for the embed top page to be the URL, then for the login iframe to
  // render the wallet picker. The picker tiles are inside the login iframe.
  // We measure TWO render milestones inside the login iframe:
  //  - chromeWall: the picker CHROME ("Continue with a wallet" heading + the
  //    React app shell) is painted. This is the page-load milestone fully
  //    reachable without a wallet, and is our primary "time-to-picker".
  //  - tileWall: a "Connect with <name>" wallet TILE appears. This requires the
  //    iframe->parent Comlink init() round-trip + wagmi connector discovery; in
  //    a headless, extension-less browser with no injected wallet it does not
  //    complete, so tileWall is typically null here. (See report: the wallet
  //    path needs the dappwright/real-wallet suite.)
  let chromeWall = null;
  let tileWall = null;
  let frameUrlSeen = null;
  let lastFrameState = "no login frame yet";
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const fr of page.frames()) {
        const u = fr.url();
        if (u.includes("/login?")) frameUrlSeen = u;
        const probe = await fr
          .evaluate(() => {
            const txt = document.body?.innerText || "";
            const tile = document.querySelector('[aria-label^="Connect with "]');
            return {
              chrome: /Continue with a wallet|Sign in to/.test(txt),
              hasTile: !!tile,
              bodyLen: txt.length,
            };
          })
          .catch(() => null);
        if (probe) {
          lastFrameState = JSON.stringify(probe);
          if (probe.chrome && !chromeWall) chromeWall = Date.now();
          if (probe.hasTile && !tileWall) tileWall = Date.now();
        }
      }
      // Stop early once chrome is up; keep a short grace window for a tile.
      if (chromeWall && (tileWall || Date.now() - chromeWall > 4000)) break;
      await sleep(50);
    }
  } catch (err) {
    lastFrameState = "poll error: " + String(err);
  }

  // Settle: give late LCP / longtasks a moment, then snapshot.
  await sleep(1500);

  const pickerRenderedWall = chromeWall; // primary milestone
  const timeToPickerWall = chromeWall ? chromeWall - t0 : null;
  const timeToTileWall = tileWall ? tileWall - t0 : null;

  // --- CDP Performance.getMetrics (top page) ---
  let cdpMetrics = {};
  try {
    const { metrics } = await client.send("Performance.getMetrics");
    for (const m of metrics) cdpMetrics[m.name] = m.value;
  } catch {}

  // --- Gather per-frame in-page perf (top + all child frames) ---
  /** @type {any[]} */
  const framePerf = [];
  for (const fr of page.frames()) {
    try {
      const data = await fr.evaluate(() => {
        const w = /** @type {any} */ (window);
        const navEntry = performance.getEntriesByType("navigation")[0];
        const nav = navEntry
          ? {
              ttfb: navEntry.responseStart,
              domContentLoaded: navEntry.domContentLoadedEventEnd,
              domInteractive: navEntry.domInteractive,
              load: navEntry.loadEventEnd,
              responseEnd: navEntry.responseEnd,
              transferSize: navEntry.transferSize,
              encodedBodySize: navEntry.encodedBodySize,
              decodedBodySize: navEntry.decodedBodySize,
              type: navEntry.type,
            }
          : null;
        const paints = performance
          .getEntriesByType("paint")
          .map((p) => ({ name: p.name, startTime: p.startTime }));
        // resource entries give per-asset transfer/decoded sizes from the page POV
        const resources = performance.getEntriesByType("resource").map((r) => ({
          name: r.name,
          initiatorType: r.initiatorType,
          duration: r.duration,
          transferSize: r.transferSize,
          encodedBodySize: r.encodedBodySize,
          decodedBodySize: r.decodedBodySize,
          startTime: r.startTime,
          responseEnd: r.responseEnd,
        }));
        return {
          url: location.href,
          nav,
          paints,
          lcp: w.__perf?.lcp ?? 0,
          longtasks: w.__perf?.longtasks ?? [],
          pickerRenderedAt: w.__perf?.pickerRenderedAt ?? null,
          resources,
          // memory if available (Chromium only)
          jsHeap: w.performance?.memory?.usedJSHeapSize ?? null,
        };
      });
      framePerf.push(data);
    } catch (err) {
      framePerf.push({ url: fr.url(), error: String(err) });
    }
  }

  // --- Stop coverage ---
  const jsCov = await page.coverage.stopJSCoverage();
  const cssCov = await page.coverage.stopCSSCoverage();

  // Summarize coverage per URL: bytes total vs used.
  const covByUrl = {};
  for (const entry of jsCov) {
    let used = 0;
    for (const fn of entry.functions || []) {
      for (const r of fn.ranges || []) {
        if (r.count > 0) used += r.endOffset - r.startOffset;
      }
    }
    const total = entry.source ? entry.source.length : entry.text?.length ?? 0;
    covByUrl[entry.url] = covByUrl[entry.url] || { type: "js", total: 0, used: 0 };
    covByUrl[entry.url].total += total;
    covByUrl[entry.url].used += Math.min(used, total);
  }
  for (const entry of cssCov) {
    let used = 0;
    for (const r of entry.ranges || []) used += r.end - r.start;
    const total = entry.text ? entry.text.length : 0;
    covByUrl[entry.url] = covByUrl[entry.url] || { type: "css", total: 0, used: 0 };
    covByUrl[entry.url].total += total;
    covByUrl[entry.url].used += Math.min(used, total);
  }

  await page.coverage.stopJSCoverage?.().catch?.(() => {});

  await context.close();

  // --- Build network summary from Playwright requests (cross-frame, with sizes) ---
  const netRows = pwRequests.map((r) => {
    const transfer =
      (r.responseBodySize ?? 0) + (r.responseHeadersSize ?? 0);
    return {
      url: r.url,
      type: r.resourceType,
      status: r.status,
      frameUrl: r.frameUrl,
      doc: docOf(r.frameUrl || r.url),
      assetBucket: assetBucket(r.url),
      transferSize: transfer,
      responseBodySize: r.responseBodySize ?? 0,
      contentEncoding: r.contentEncoding,
      contentType: r.contentType,
      cacheControl: r.cacheControl,
      timing: r.timing,
    };
  });

  return {
    iter: idx,
    cold,
    timeToPickerWall,
    timeToTileWall,
    pickerRendered: !!pickerRenderedWall,
    tileRendered: !!tileWall,
    lastFrameState,
    frameUrlSeen,
    cdpMetrics,
    framePerf,
    coverage: covByUrl,
    network: netRows,
    cdpFinished: finished.map((r) => ({
      url: r.url,
      type: r.respType || r.type,
      status: r.status,
      mimeType: r.mimeType,
      protocol: r.protocol,
      contentEncoding: r.contentEncoding,
      encodedDataLength: r.encodedDataLength,
      fromCache: r.fromCache,
    })),
  };
}

async function main() {
  console.log(
    `Perf run: ${ITERS} iters, ${COLD ? "COLD (cache cleared)" : "WARM"}; demo=${DEMO_URL}`
  );
  const browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const version = browser.version();
  const results = [];
  for (let i = 0; i < ITERS; i++) {
    process.stdout.write(`  iter ${i + 1}/${ITERS} ... `);
    try {
      const r = await runIteration(browser, i, COLD);
      results.push(r);
      console.log(
        `picker=${r.pickerRendered ? "YES" : "NO"} ttPicker=${
          r.timeToPickerWall ?? "n/a"
        }ms`
      );
    } catch (err) {
      console.log(`ERROR: ${err}`);
      results.push({ iter: i, error: String(err) });
    }
  }
  await browser.close();

  const tag = COLD ? "cold" : "warm";
  const outPath = join(OUT_DIR, `perf-${tag}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ browser: version, demo: DEMO_URL, login: LOGIN_URL, iters: ITERS, cold: COLD, results }, null, 2)
  );
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
