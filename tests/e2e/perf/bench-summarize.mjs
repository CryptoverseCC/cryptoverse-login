// @ts-check
/**
 * Fold bench-{warm,cold}.json into distribution tables + a phase breakdown +
 * a network/cache analysis. Writes out/bench-summary.txt and a machine-readable
 * out/bench-aggregate.json. READ-ONLY analysis of the captured runs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "out");

function stats(xs) {
  const v = xs.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n, min: v[0], max: v[n - 1], mean: +mean.toFixed(1),
    median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
    stddev: +Math.sqrt(variance).toFixed(1),
  };
}

function fmt(s) {
  if (!s || !s.n) return "n=0";
  return `median ${s.median}  mean ${s.mean}  p95 ${s.p95}  min ${s.min}  max ${s.max}  sd ${s.stddev}  n=${s.n}`;
}

// Find a frame in framePerf by url substring.
function frameBy(fp, sub) {
  return (fp || []).find((f) => (f.url || "").includes(sub));
}
function fcpOf(f) {
  const p = (f?.paints || []).find((x) => x.name === "first-contentful-paint");
  return p ? p.startTime : null;
}

// Attribute a network row to a document by URL PATH (more reliable than the
// captured frameUrl, which can resolve to the demo origin for embed assets).
function docByPath(url) {
  const u = url || "";
  if (u.includes("login-demo.cv.127.0.0.1.nip.io") && !u.includes("/login/") && !u.includes("/oauth2/"))
    return "demo";
  if (u.includes("/oauth2/")) return "embed-doc";
  if (u.includes("embed.js") || u.includes("sentry.min.js") || (u.includes("comlink") && u.includes("/static/")))
    return "embed-assets";
  if (u.includes("/login")) return "login-spa";
  if (u.includes("unpkg") || u.includes("purecss")) return "demo-cdn";
  return "other";
}

function loadCohort(tag) {
  const p = join(OUT, `bench-${tag}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function analyze(data, lines) {
  const m = data.meta;
  const ok = data.results.filter((r) => !r.error && r.tileRendered);
  const all = data.results.filter((r) => !r.error);
  lines.push(`\n${"#".repeat(60)}`);
  lines.push(`# ${m.cohort.toUpperCase()} cohort — ${m.iters} iters, browser ${m.browser}`);
  lines.push(`# ran ${m.ranAt}`);
  lines.push(`# tiles rendered: ${ok.length}/${all.length}; errors: ${data.results.length - all.length}`);
  lines.push("#".repeat(60));

  // ---- discard-first-as-warmup check ----
  const ttTileAll = ok.map((r) => r.timeToFirstTile);
  const firstVal = ok[0]?.timeToFirstTile;
  const restMedian = stats(ok.slice(1).map((r) => r.timeToFirstTile)).median;
  const isOutlier = firstVal != null && restMedian != null && firstVal > restMedian * 1.4;
  lines.push(`\nWarmup: iter#1 ttTile=${firstVal}ms vs rest-median=${restMedian}ms` +
    (isOutlier ? "  -> FIRST IS OUTLIER, excluded from stats below" : "  -> first is in-band, kept"));
  const used = isOutlier ? ok.slice(1) : ok;

  // ---- key milestone distributions (wall clock from demo nav start) ----
  lines.push(`\n-- Key milestones (wall clock, ms from demo navigation start) --`);
  lines.push(`time-to-landing button     : ${fmt(stats(used.map((r) => r.timeToLanding)))}`);
  lines.push(`time-to-FIRST WALLET TILE  : ${fmt(stats(used.map((r) => r.timeToFirstTile)))}   <== key UX number`);
  lines.push(`landing->click (driver gap): ${fmt(stats(used.map((r) => r.landingToClick)))}   (automation think-time, not user)`);
  lines.push(`POST-CLICK delta to tile   : ${fmt(stats(used.map((r) => r.postClickDelta)))}   (handshake + app chunk + init + discovery)`);

  // ---- per-document nav/paint ----
  const collect = (sub, field, paint) =>
    used.map((r) => {
      const f = frameBy(r.framePerf, sub);
      if (!f) return null;
      if (paint) return fcpOf(f);
      return f.nav ? f.nav[field] : null;
    });
  lines.push(`\n-- Per-document navigation/paint (in-page Navigation Timing / paint, ms) --`);
  for (const [label, sub] of [["EMBED top doc (/oauth2/auth)", "/oauth2/auth"], ["LOGIN SPA (/login?login_challenge)", "/login?"]]) {
    lines.push(`  ${label}:`);
    lines.push(`     TTFB : ${fmt(stats(collect(sub, "ttfb")))}`);
    lines.push(`     FCP  : ${fmt(stats(collect(sub, null, true)))}`);
    lines.push(`     LCP  : ${fmt(stats(used.map((r) => { const f = frameBy(r.framePerf, sub); return f?.lcp || null; })))}`);
    lines.push(`     DCL  : ${fmt(stats(collect(sub, "domContentLoaded")))}`);
    lines.push(`     load : ${fmt(stats(collect(sub, "load")))}`);
  }

  // ---- Comlink handshake + init/discovery ----
  lines.push(`\n-- Comlink handshake + init()/discovery (in-page perf.now markers, ms) --`);
  // embed doc holds the `hello`-received + connectorsLogged markers; login frame holds `embed-ready`-received.
  const embedHello = used.map((r) => frameBy(r.framePerf, "/oauth2/auth")?.hs?.firstHelloAt ?? null);
  const embedConnLogged = used.map((r) => frameBy(r.framePerf, "/oauth2/auth")?.connectorsLoggedAt ?? null);
  const loginReady = used.map((r) => frameBy(r.framePerf, "/login?")?.hs?.firstReadyAt ?? null);
  const connCounts = used.map((r) => frameBy(r.framePerf, "/oauth2/auth")?.connectorsCount ?? null).filter((x) => x != null);
  lines.push(`  embed: first 'hello' received at (since embed doc origin): ${fmt(stats(embedHello))}`);
  lines.push(`  embed: '[cryptoverse] connectors:' logged at (init discovery done): ${fmt(stats(embedConnLogged))}`);
  lines.push(`  login SPA: first 'embed-ready' received at (since SPA origin)    : ${fmt(stats(loginReady))}`);
  lines.push(`  connectors discovered per iter: ${connCounts.length ? `${Math.min(...connCounts)}..${Math.max(...connCounts)} (typical ${stats(connCounts).median})` : "n/a"}`);

  // ---- CDP Performance.getMetrics (top page) selected ----
  const cdpField = (k) => used.map((r) => r.cdpMetrics?.[k]).filter((x) => x != null);
  lines.push(`\n-- CDP Performance.getMetrics (top page, selected) --`);
  for (const k of ["ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "TaskDuration", "JSHeapUsedSize"]) {
    const xs = cdpField(k);
    if (!xs.length) continue;
    const scale = k === "JSHeapUsedSize" ? 1 / (1024 * 1024) : 1000; // s->ms, bytes->MB
    const unit = k === "JSHeapUsedSize" ? "MB" : "ms";
    lines.push(`  ${k.padEnd(20)}: ${fmt(stats(xs.map((x) => +(x * scale).toFixed(1))))} ${unit}`);
  }

  // ---- long tasks across all frames ----
  let totalLong = 0, longList = [];
  for (const r of used) for (const f of r.framePerf || []) for (const lt of f.longtasks || []) { totalLong++; longList.push(lt.duration); }
  lines.push(`\n-- Main thread: long tasks >50ms across all frames (all kept iters) --`);
  lines.push(`  count: ${totalLong}${longList.length ? `  durations(ms): ${longList.map((d) => d.toFixed(0)).slice(0, 12).join(", ")}` : "  (none)"}`);

  // ---- network: per-doc transfer + cache behavior ----
  // Use the LAST kept iter for the per-asset table (stable), aggregate transfer across iters.
  const perDocTotals = {};
  const cacheModes = { withCacheControl: 0, onlyLastModified: 0, etag: 0, none: 0 };
  const transferPerIter = [];
  const fromCacheCounts = [];
  for (const r of used) {
    let iterTotal = 0;
    const seen = new Set();
    let cachedThisIter = 0, cacheableThisIter = 0;
    for (const n of r.network) {
      if (seen.has(n.url + n.transferSize)) continue;
      seen.add(n.url + n.transferSize);
      const d = docByPath(n.url);
      perDocTotals[d] = (perDocTotals[d] || 0) + n.transferSize;
      iterTotal += n.transferSize;
      // cache classification only for login-host static assets (the ones WE serve)
      if (d === "login-spa" || d === "embed-assets") {
        cacheableThisIter++;
        if (n.fromDiskCache) cachedThisIter++;
      }
    }
    transferPerIter.push(iterTotal / 1024);
    fromCacheCounts.push({ cached: cachedThisIter, cacheable: cacheableThisIter });
  }
  // cache header classification from last iter
  const lastIter = used[used.length - 1];
  const ourAssets = lastIter.network.filter((n) => ["login-spa", "embed-assets"].includes(docByPath(n.url)));
  for (const n of ourAssets) {
    if (n.cacheControl) cacheModes.withCacheControl++;
    else if (n.etag) cacheModes.etag++;
    else if (n.lastModified) cacheModes.onlyLastModified++;
    else cacheModes.none++;
  }
  lines.push(`\n-- Network transfer over the wire (per iter, KB) --`);
  lines.push(`  TOTAL per iter: ${fmt(stats(transferPerIter))}`);
  lines.push(`  Per-document (summed over kept iters, avg KB/iter):`);
  for (const [d, bytes] of Object.entries(perDocTotals).sort((a, b) => b[1] - a[1]))
    lines.push(`     ${d.padEnd(14)}: ${(bytes / 1024 / used.length).toFixed(1)} KB/iter`);

  lines.push(`\n-- Cache behavior (login-host static assets WE serve) --`);
  lines.push(`  Cache-header classification (last iter, ${ourAssets.length} of our assets):`);
  lines.push(`     with Cache-Control : ${cacheModes.withCacheControl}`);
  lines.push(`     ETag only          : ${cacheModes.etag}`);
  lines.push(`     Last-Modified only : ${cacheModes.onlyLastModified}  <== revalidation, not free cache`);
  lines.push(`     no validators      : ${cacheModes.none}`);
  const avgCached = fromCacheCounts.reduce((a, b) => a + (b.cacheable ? b.cached / b.cacheable : 0), 0) / fromCacheCounts.length;
  lines.push(`  Served from DISK CACHE (CDP fromDiskCache), avg across iters: ${(avgCached * 100).toFixed(0)}% of our static assets`);
  lines.push(`     (WARM should be high if assets were cacheable; if low, the browser is revalidating every time.)`);

  // ---- largest assets table (last iter) ----
  lines.push(`\n-- Largest assets (last kept iter; transfer KB / encoding / cache-control / doc) --`);
  const seen = {};
  for (const n of lastIter.network) if (!seen[n.url] || seen[n.url].transferSize < n.transferSize) seen[n.url] = n;
  Object.values(seen).sort((a, b) => b.transferSize - a.transferSize).slice(0, 14).forEach((n) => {
    lines.push(`   ${(n.transferSize / 1024).toFixed(1).padStart(7)} KB  ${(n.contentEncoding || "none").padEnd(5)}  cc=[${(n.cacheControl || "").slice(0, 22).padEnd(22)}]  ${docByPath(n.url).padEnd(13)} ${n.url.replace(/https:\/\/[^/]+/, "").slice(0, 46)}`);
  });

  return { cohort: m.cohort, used: used.length, milestones: {
    timeToLanding: stats(used.map((r) => r.timeToLanding)),
    timeToFirstTile: stats(used.map((r) => r.timeToFirstTile)),
    postClickDelta: stats(used.map((r) => r.postClickDelta)),
  }, transferKBperIter: stats(transferPerIter), perDocAvgKB: Object.fromEntries(Object.entries(perDocTotals).map(([d, b]) => [d, +(b / 1024 / used.length).toFixed(1)])), cacheModes, diskCachePct: +(avgCached * 100).toFixed(0) };
}

const lines = [];
lines.push("CRYPTOVERSE LOGIN — REAL BENCHMARK SUMMARY (page-load -> wallet picker interactive)");
lines.push("=================================================================================");
const agg = {};
for (const tag of ["warm", "cold"]) {
  const data = loadCohort(tag);
  if (!data) { lines.push(`\n[${tag}] no data file`); continue; }
  agg[tag] = analyze(data, lines);
}
fs.writeFileSync(join(OUT, "bench-summary.txt"), lines.join("\n") + "\n");
fs.writeFileSync(join(OUT, "bench-aggregate.json"), JSON.stringify(agg, null, 2) + "\n");
fs.writeFileSync("/tmp/bench-summary.txt", lines.join("\n") + "\n");
