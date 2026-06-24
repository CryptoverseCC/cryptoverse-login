// @ts-check
/**
 * REAL ≥20x page-load benchmark of the Cryptoverse Login flow against the live
 * kind stack. READ-ONLY / measurement-only — drives a real Chromium (the
 * Playwright build) over CDP and captures, per iteration, the full
 * demo→picker-rendered timeline.
 *
 * This is the successor to perf.mjs. Differences that matter for THIS task:
 *  - The deployed login image now ships the FIXED Comlink handshake, so the
 *    wallet TILES actually render in plain headless Chromium (the Coinbase
 *    connector is always offered + EIP-6963 injected fallback). perf.mjs noted
 *    tiles "never render"; that is resolved. So we can finally measure
 *    TIME-TO-PICKER-INTERACTIVE (first `Connect with …` tile visible) end to end.
 *  - We split the wall clock into the three user-visible milestones:
 *      t0                     demo navigation start
 *      tLanding   ("Continue with a wallet" button visible+clickable)
 *      [click]
 *      tFirstTile (first `aria-label^="Connect with "` tile visible)
 *    and report the POST-CLICK DELTA (tFirstTile - clickTs) = the handshake +
 *    lazy `app` chunk load/eval + init() + listWallets() discovery, which is the
 *    part the user actively waits on after committing to "continue".
 *  - We instrument the Comlink handshake directly: an init script wraps
 *    window.postMessage / addEventListener('message') in EVERY document and
 *    timestamps the `embed-ready` and `hello` markers, plus latches the embed's
 *    `[cryptoverse] connectors:` console.info (fires inside init() once the
 *    wagmi config is built + connectors enumerated) and the App-mount instant.
 *  - Two cohorts kept strictly separate: WARM (one browser context reused across
 *    all iterations so the HTTP cache persists) and COLD (fresh context +
 *    Network.clearBrowserCache + setCacheDisabled(true) every iteration).
 *
 * Usage:
 *   node bench.mjs --iters 28 --cohort warm --tag warm
 *   node bench.mjs --iters 28 --cohort cold --tag cold
 * Env: DEMO_URL, LOGIN_URL (default kind nip.io :9443 hosts).
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
const ITERS = Number(flag("iters", 28));
const COHORT = String(flag("cohort", "warm")); // "warm" | "cold"
const TAG = String(flag("tag", COHORT));
const COLD = COHORT === "cold";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify a request URL into one of the three documents of the flow. */
function docOf(url, frameUrl) {
  const u = url || "";
  const f = frameUrl || "";
  if (u.includes("login-demo.cv.127.0.0.1.nip.io") || f.includes("login-demo.cv.127.0.0.1.nip.io"))
    return "demo";
  // The login host serves BOTH the wrapper embed page (top window) AND the
  // /login SPA + assets (iframe). Split by the frame the request belongs to:
  // the embed top doc lives at /oauth2/auth; the SPA + its assets at /login/.
  if (u.includes("/oauth2/")) return "embed-doc"; // wrapper embed html + hydra authorize
  if (f.includes("/oauth2/")) return "embed-assets"; // embed.js, sentry.min.js, comlink
  if (u.includes("login.cv.127.0.0.1.nip.io") || f.includes("/login"))
    return "login-spa"; // /login html + main bundle + css + fonts + lazy chunks
  return "other";
}

function assetBucket(url) {
  const u = url.toLowerCase();
  if (u.includes("embed.js")) return "embed.js";
  if (u.includes("final.js")) return "final.js";
  if (u.includes("sentry")) return "sentry";
  if (u.includes("comlink")) return "comlink";
  if (u.includes("/static/js/") && u.endsWith(".js")) return "js-chunk";
  if (u.endsWith(".css")) return "css";
  if (u.endsWith(".woff2") || u.endsWith(".woff") || u.endsWith(".ttf"))
    return "font";
  if (u.endsWith(".png") || u.endsWith(".svg") || u.endsWith(".jpg"))
    return "image";
  return "other";
}

/**
 * Init script injected into EVERY document (top + iframes). It records paint /
 * LCP / longtask entries, marks when the wallet tile renders, marks when the
 * "Continue with a wallet" landing button appears, and instruments the Comlink
 * handshake by wrapping postMessage + message events to timestamp the
 * `embed-ready` / `hello` markers. It also latches the embed's
 * `[cryptoverse] connectors:` console.info (fires inside init() once the wagmi
 * config is built + connectors enumerated).
 */
function makeInitScript() {
  return () => {
    // @ts-nocheck
    const w = /** @type {any} */ (window);
    if (w.__bench) return;
    const now = () => performance.now();
    w.__bench = {
      url: location.href,
      tNavigationStart: performance.timeOrigin,
      paints: [],
      lcp: 0,
      longtasks: [],
      // milestones (performance.now() within THIS document)
      landingVisibleAt: null, // "Continue with a wallet" button present
      appMountAt: null, // first sign the picker App mounted (loader/status swap)
      firstTileAt: null, // first `Connect with …` tile present
      errorAt: null, // "couldn't load your wallets"
      // handshake (timestamped via postMessage wrap)
      hs: { firstReadyAt: null, firstHelloAt: null, readyCount: 0, helloCount: 0 },
      // embed init() discovery completion (console marker)
      connectorsLoggedAt: null,
      connectorsCount: null,
    };

    // ---- paint / LCP / longtask observers ----
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          w.__bench.paints.push({ name: e.name, startTime: e.startTime });
      }).observe({ type: "paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((l) => {
        const es = l.getEntries();
        const last = es[es.length - 1];
        if (last) w.__bench.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          w.__bench.longtasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {}

    // ---- DOM milestones via MutationObserver ----
    const scan = () => {
      const b = w.__bench;
      const txt = (document.body && document.body.innerText) || "";
      if (!b.landingVisibleAt && /Continue with a wallet/.test(txt))
        b.landingVisibleAt = now();
      if (!b.firstTileAt) {
        const tile = document.querySelector('[aria-label^="Connect with "]');
        if (tile) b.firstTileAt = now();
      }
      if (!b.errorAt && /couldn.t load your wallets/i.test(txt))
        b.errorAt = now();
    };
    try {
      const mo = new MutationObserver(scan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      // also scan once after DOMContentLoaded for the static landing
      document.addEventListener("DOMContentLoaded", scan);
    } catch {}

    // ---- Comlink handshake instrumentation ----
    // Wrap the inbound message listener: timestamp the first `embed-ready`
    // (parent→iframe) and `hello` (iframe→parent) markers as they arrive.
    try {
      window.addEventListener(
        "message",
        (ev) => {
          const d = ev && ev.data;
          if (d && d.__cryptoverse === "embed-ready") {
            w.__bench.hs.readyCount++;
            if (!w.__bench.hs.firstReadyAt) w.__bench.hs.firstReadyAt = now();
          }
          if (d && d.__cryptoverse === "hello") {
            w.__bench.hs.helloCount++;
            if (!w.__bench.hs.firstHelloAt) w.__bench.hs.firstHelloAt = now();
          }
        },
        true
      );
    } catch {}

    // ---- console marker latch: embed init() discovery completion ----
    try {
      const origInfo = console.info.bind(console);
      console.info = (...args) => {
        try {
          if (
            typeof args[0] === "string" &&
            args[0].includes("[cryptoverse] connectors:")
          ) {
            if (!w.__bench.connectorsLoggedAt) {
              w.__bench.connectorsLoggedAt = now();
              const list = args[1];
              w.__bench.connectorsCount = Array.isArray(list)
                ? list.length
                : null;
            }
          }
        } catch {}
        return origInfo(...args);
      };
    } catch {}
  };
}

/** Read the bench object from every frame and return an array. */
async function collectFramePerf(page) {
  const out = [];
  for (const fr of page.frames()) {
    try {
      const data = await fr.evaluate(() => {
        const w = /** @type {any} */ (window);
        const navEntry = performance.getEntriesByType("navigation")[0];
        const nav = navEntry
          ? {
              ttfb: navEntry.responseStart,
              requestStart: navEntry.requestStart,
              domInteractive: navEntry.domInteractive,
              domContentLoaded: navEntry.domContentLoadedEventEnd,
              load: navEntry.loadEventEnd,
              responseEnd: navEntry.responseEnd,
              connectStart: navEntry.connectStart,
              connectEnd: navEntry.connectEnd,
              secureConnectionStart: navEntry.secureConnectionStart,
              domainLookupStart: navEntry.domainLookupStart,
              domainLookupEnd: navEntry.domainLookupEnd,
              transferSize: navEntry.transferSize,
              encodedBodySize: navEntry.encodedBodySize,
              decodedBodySize: navEntry.decodedBodySize,
              type: navEntry.type,
            }
          : null;
        const paints = performance
          .getEntriesByType("paint")
          .map((p) => ({ name: p.name, startTime: p.startTime }));
        const b = w.__bench || {};
        return {
          url: location.href,
          nav,
          paints,
          lcp: b.lcp ?? 0,
          longtasks: b.longtasks ?? [],
          landingVisibleAt: b.landingVisibleAt ?? null,
          firstTileAt: b.firstTileAt ?? null,
          errorAt: b.errorAt ?? null,
          hs: b.hs ?? null,
          connectorsLoggedAt: b.connectorsLoggedAt ?? null,
          connectorsCount: b.connectorsCount ?? null,
          timeOrigin: performance.timeOrigin,
          jsHeap: w.performance?.memory?.usedJSHeapSize ?? null,
        };
      });
      out.push(data);
    } catch (err) {
      out.push({ url: fr.url(), error: String(err) });
    }
  }
  return out;
}

async function runIteration(ctx, idx, cold) {
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Performance.enable", { timeDomain: "timeTicks" }).catch(() => {});
  if (cold) {
    await client.send("Network.clearBrowserCache");
    await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  }

  // Network capture at the Playwright level (cross-frame, with real sizes).
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
        fromCache: !!(/** @type {any} */ (resp).fromCache?.()),
        ...sizes,
        contentEncoding: (headers["content-encoding"] || "").toLowerCase(),
        contentType: headers["content-type"] || "",
        cacheControl: headers["cache-control"] || "",
        etag: headers["etag"] || "",
        lastModified: headers["last-modified"] || "",
        contentLength: headers["content-length"] || "",
        timing,
      });
    } catch {}
  });
  // Also capture 304s / served-from-cache via CDP responseReceived (Playwright
  // requestfinished still fires, but fromDiskCache is only on the CDP event).
  /** @type {Map<string,any>} */
  const cdpResp = new Map();
  client.on("Network.responseReceived", (e) => {
    cdpResp.set(e.response.url, {
      status: e.response.status,
      fromDiskCache: e.response.fromDiskCache,
      fromPrefetchCache: e.response.fromPrefetchCache,
      fromServiceWorker: e.response.fromServiceWorker,
    });
  });

  await ctx.addInitScript(makeInitScript());

  // ----- DRIVE THE FLOW -----
  const t0 = Date.now();
  await page.goto(DEMO_URL + "/", { waitUntil: "load" });

  // Click demo login -> /oauth2/auth embed -> iframe -> Hydra -> /login SPA.
  await page.getByText("Login with Ethereum Wallet").click();

  // Wait for the "Continue with a wallet" landing button inside the login
  // iframe, then click it to MOUNT the picker App (fires init()).
  let landingWall = null;
  let clickWall = null;
  let firstTileWall = null;
  let errorWall = null;
  let lastState = "no login frame";
  const loginFrame = page.frameLocator("iframe").first();
  try {
    const continueBtn = loginFrame.locator(
      'button:has-text("Continue with a wallet")'
    );
    await continueBtn.waitFor({ state: "visible", timeout: 30_000 });
    landingWall = Date.now();
    // Click to mount the picker App -> init() handshake + discovery.
    await continueBtn.click();
    clickWall = Date.now();

    // Now wait for the first wallet tile (init resolved) OR the error state.
    const tile = loginFrame.locator('[aria-label^="Connect with "]').first();
    const err = loginFrame.getByText(/couldn.t load your wallets/i);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const tv = await tile.isVisible().catch(() => false);
      if (tv) {
        firstTileWall = Date.now();
        break;
      }
      const ev = await err.isVisible().catch(() => false);
      if (ev) {
        errorWall = Date.now();
        break;
      }
      await sleep(20);
    }
    lastState = firstTileWall
      ? "tile-rendered"
      : errorWall
        ? "error-state"
        : "timeout-no-tile";
  } catch (e) {
    lastState = "drive-error: " + String(e);
  }

  // Settle for late LCP / longtasks.
  await sleep(800);

  // CDP Performance.getMetrics (top page).
  let cdpMetrics = {};
  try {
    const { metrics } = await client.send("Performance.getMetrics");
    for (const m of metrics) cdpMetrics[m.name] = m.value;
  } catch {}

  const framePerf = await collectFramePerf(page);

  // Network rows.
  const netRows = pwRequests.map((r) => {
    const transfer = (r.responseBodySize ?? 0) + (r.responseHeadersSize ?? 0);
    const cdp = cdpResp.get(r.url) || {};
    return {
      url: r.url,
      type: r.resourceType,
      status: r.status,
      frameUrl: r.frameUrl,
      doc: docOf(r.url, r.frameUrl),
      assetBucket: assetBucket(r.url),
      transferSize: transfer,
      responseBodySize: r.responseBodySize ?? 0,
      responseHeadersSize: r.responseHeadersSize ?? 0,
      contentEncoding: r.contentEncoding,
      contentType: r.contentType,
      cacheControl: r.cacheControl,
      etag: r.etag ? "yes" : "",
      lastModified: r.lastModified ? "yes" : "",
      fromDiskCache: !!cdp.fromDiskCache,
      cdpStatus: cdp.status ?? null,
      timing: r.timing,
    };
  });

  await page.close();

  // Milestone deltas (wall clock from demo nav start).
  const timeToLanding = landingWall ? landingWall - t0 : null;
  const timeToFirstTile = firstTileWall ? firstTileWall - t0 : null;
  const postClickDelta =
    firstTileWall && clickWall ? firstTileWall - clickWall : null;
  const landingToClick = clickWall && landingWall ? clickWall - landingWall : null;

  return {
    iter: idx,
    cold,
    lastState,
    tileRendered: !!firstTileWall,
    errorRendered: !!errorWall,
    timeToLanding,
    timeToFirstTile,
    landingToClick,
    postClickDelta,
    cdpMetrics,
    framePerf,
    network: netRows,
  };
}

async function main() {
  console.log(
    `BENCH: ${ITERS} iters, cohort=${COHORT} (${COLD ? "COLD" : "WARM"}), tag=${TAG}`
  );
  const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  const version = browser.version();

  // WARM: one shared context across all iters (cache persists). COLD: a fresh
  // context per iter (created inside the loop) with cache cleared+disabled.
  let sharedCtx = null;
  if (!COLD) {
    sharedCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  }

  const results = [];
  for (let i = 0; i < ITERS; i++) {
    process.stdout.write(`  iter ${i + 1}/${ITERS} ... `);
    let ctx = sharedCtx;
    try {
      if (COLD) ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const r = await runIteration(ctx, i, COLD);
      results.push(r);
      console.log(
        `${r.tileRendered ? "TILE" : r.errorRendered ? "ERR " : "----"} ` +
          `ttTile=${r.timeToFirstTile ?? "n/a"}ms postClick=${
            r.postClickDelta ?? "n/a"
          }ms`
      );
    } catch (err) {
      console.log(`ERROR: ${err}`);
      results.push({ iter: i, error: String(err) });
    } finally {
      if (COLD && ctx) await ctx.close().catch(() => {});
    }
  }
  if (sharedCtx) await sharedCtx.close().catch(() => {});
  await browser.close();

  const outPath = join(OUT_DIR, `bench-${TAG}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          browser: version,
          demo: DEMO_URL,
          login: LOGIN_URL,
          iters: ITERS,
          cohort: COHORT,
          cold: COLD,
          ranAt: new Date().toISOString(),
        },
        results,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
