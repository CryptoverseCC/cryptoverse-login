// Aggregate perf-warm.json / perf-cold.json into median tables + a text report.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "out");

const median = (xs) => {
  const a = xs.filter((x) => x != null && !Number.isNaN(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const spread = (xs) => {
  const a = xs.filter((x) => x != null).sort((p, q) => p - q);
  return a.length ? `${Math.round(a[0])}–${Math.round(a[a.length - 1])}` : "n/a";
};
const kb = (b) => (b == null ? "?" : (b / 1024).toFixed(1));

function loadFile(tag) {
  const p = join(OUT, `perf-${tag}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function frameMetric(results, frameMatch, key) {
  const vals = [];
  for (const r of results) {
    if (r.error) continue;
    for (const f of r.framePerf || []) {
      if (!f.url || !frameMatch(f.url)) continue;
      const nav = f.nav;
      if (!nav) continue;
      let v = null;
      if (key === "ttfb") v = nav.ttfb;
      else if (key === "dcl") v = nav.domContentLoaded;
      else if (key === "load") v = nav.load;
      else if (key === "fcp") v = (f.paints || []).find((p) => p.name === "first-contentful-paint")?.startTime;
      else if (key === "fp") v = (f.paints || []).find((p) => p.name === "first-paint")?.startTime;
      else if (key === "lcp") v = f.lcp || null;
      if (v != null && v >= 0) vals.push(v);
    }
  }
  return vals;
}

const isEmbed = (u) => u.includes("/oauth2/auth");
const isLogin = (u) => u.includes("/login?");
const isDemo = (u) => u.includes("login-demo.cv.127.0.0.1.nip.io") && !u.includes("/oauth2");

function report(tag) {
  const data = loadFile(tag);
  if (!data) return `(no ${tag} data)\n`;
  const R = data.results.filter((r) => !r.error);
  const L = [];
  L.push(`\n########## ${tag.toUpperCase()} (${R.length} iters, browser ${data.browser}) ##########`);

  // --- milestones ---
  L.push(`\n-- Flow milestones (ms from demo.goto) --`);
  const ttp = R.map((r) => r.timeToPickerWall);
  const ttt = R.map((r) => r.timeToTileWall).filter((x) => x != null);
  L.push(`time-to-picker-chrome:  median ${median(ttp)}ms  [${spread(ttp)}]`);
  L.push(`time-to-wallet-tile:    ${ttt.length ? `median ${median(ttt)}ms [${spread(ttt)}]` : "NEVER rendered (Comlink init/discovery needs a real wallet — see notes)"}`);
  L.push(`picker chrome rendered: ${R.filter((r) => r.pickerRendered).length}/${R.length} iters`);

  // --- per-document nav/paint ---
  for (const [label, match] of [["DEMO RP", isDemo], ["EMBED (/oauth2/auth)", isEmbed], ["IFRAME (/login SPA)", isLogin]]) {
    L.push(`\n-- ${label} navigation/paint (median ms) --`);
    for (const k of ["ttfb", "fp", "fcp", "lcp", "dcl", "load"]) {
      const v = median(frameMetric(R, match, k));
      L.push(`  ${k.padEnd(5)}: ${v != null ? Math.round(v) : "n/a"}`);
    }
  }

  // --- network: aggregate per-iteration, then median totals ---
  // Use the LAST iteration's network as a representative waterfall, plus median total transfer.
  const totalsByDoc = {}; // doc -> [bytes per iter]
  const totalAll = [];
  for (const r of R) {
    const perDoc = {};
    let all = 0;
    for (const n of r.network || []) {
      perDoc[n.doc] = (perDoc[n.doc] || 0) + (n.transferSize || 0);
      all += n.transferSize || 0;
    }
    for (const [d, b] of Object.entries(perDoc)) (totalsByDoc[d] ||= []).push(b);
    totalAll.push(all);
  }
  L.push(`\n-- Network transfer (over the wire, median across iters) --`);
  L.push(`  TOTAL: ${kb(median(totalAll))} KB`);
  for (const [d, arr] of Object.entries(totalsByDoc).sort((a, b) => median(b[1]) - median(a[1])))
    L.push(`    ${d.padEnd(14)}: ${kb(median(arr))} KB`);

  // largest assets (from last iter), with compression flag
  const last = R[R.length - 1];
  const assets = (last.network || [])
    .map((n) => ({ url: n.url, t: n.transferSize || 0, enc: n.contentEncoding, type: n.type, body: n.responseBodySize, cc: n.cacheControl }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 12);
  L.push(`\n-- Largest assets (last iter; transfer KB / body KB / encoding / cache) --`);
  for (const a of assets) {
    let short = a.url;
    try { const u = new URL(a.url); short = u.host.split(".")[0] + u.pathname; } catch {}
    L.push(`  ${kb(a.t).padStart(8)} / ${kb(a.body).padStart(8)} ${(a.enc || "NONE").padEnd(5)} ${(a.cc || "-").slice(0, 22).padEnd(22)} ${short.slice(0, 52)}`);
  }
  // compression gaps
  const uncompressed = (last.network || []).filter((n) => (n.transferSize || 0) > 1500 && !n.contentEncoding && /script|stylesheet|document|font/.test(n.type));
  if (uncompressed.length) {
    L.push(`\n-- Uncompressed >1.5KB text assets --`);
    for (const u of uncompressed) L.push(`  ${kb(u.transferSize).padStart(8)} KB  ${u.url.slice(0, 70)}`);
  } else L.push(`\n-- Compression: all text assets >1.5KB are compressed (gzip/br). --`);

  // --- coverage worst offenders (use the iter with most coverage entries) ---
  let bestCov = null;
  for (const r of R) {
    const n = Object.keys(r.coverage || {}).length;
    if (!bestCov || n > Object.keys(bestCov).length) bestCov = r.coverage;
  }
  if (bestCov) {
    const rows = Object.entries(bestCov)
      .map(([url, c]) => ({ url, ...c, unused: c.total - c.used, pct: c.total ? (c.used / c.total) * 100 : 0 }))
      .filter((c) => c.total > 3000)
      .sort((a, b) => b.unused - a.unused)
      .slice(0, 12);
    L.push(`\n-- Coverage: worst unused (during page load, before connect) --`);
    L.push(`  unusedKB  usedKB  totalKB  used%  asset`);
    for (const c of rows) {
      let short = c.url; try { const u = new URL(c.url); short = u.pathname.split("/").pop(); } catch {}
      L.push(`  ${kb(c.unused).padStart(8)} ${kb(c.used).padStart(7)} ${kb(c.total).padStart(8)} ${c.pct.toFixed(0).padStart(5)}%  ${(short || c.url).slice(0, 40)}`);
    }
    const totUnused = rows.reduce((s, c) => s + c.unused, 0);
    L.push(`  (sum of listed unused: ${kb(totUnused)} KB — NB these are decoded/source bytes, not wire bytes)`);
  }

  // --- main thread: long tasks across all frames ---
  const lts = [];
  for (const r of R) for (const f of r.framePerf || []) for (const t of f.longtasks || []) lts.push(t.duration);
  lts.sort((a, b) => b - a);
  const tbt = (arr) => arr.reduce((s, d) => s + Math.max(0, d - 50), 0);
  // per-iter TBT
  const tbtPer = R.map((r) => {
    let sum = 0;
    for (const f of r.framePerf || []) for (const t of f.longtasks || []) sum += Math.max(0, t.duration - 50);
    return sum;
  });
  L.push(`\n-- Main thread (long tasks >50ms, all frames) --`);
  L.push(`  long tasks observed: ${lts.length} total across ${R.length} iters`);
  L.push(`  longest single tasks (ms): ${lts.slice(0, 8).map((x) => Math.round(x)).join(", ")}`);
  L.push(`  approx Total Blocking Time / iter: median ${median(tbtPer) != null ? Math.round(median(tbtPer)) : "n/a"}ms [${spread(tbtPer)}]`);

  return L.join("\n");
}

let out = "CRYPTOVERSE LOGIN — LIVE PERF SUMMARY\n=====================================";
out += report("warm");
out += "\n";
out += report("cold");
writeFileSync(join(OUT, "summary.txt"), out);
console.log(out);
