// @ts-check
/**
 * Approach-B (proper): measure the connect-time wallet-SDK chunks' TRANSFER bytes
 * AND parse+compile+eval cost by importing them inside the EMBED page's own
 * origin (https://login.../oauth2/auth), where their sibling deps resolve (the
 * earlier about:blank attempt failed: cross-origin module import + missing peer
 * modules threw at top-level, truncating eval).
 *
 * We load the live embed page (no wallet needed), then for each target chunk do
 * a dynamic import() from the page and trace it with CDP (devtools.timeline +
 * v8). Because we import from the real origin with the real graph, the chunk and
 * its not-yet-loaded deps compile + top-level-eval the way they would on a real
 * connect. We import each chunk in its own fresh page so their costs don't
 * overlap, and we import a tiny baseline chunk first to subtract page warmup.
 *
 * Caveat: importing a chunk in isolation still differs from the exact connect
 * path (which imports a specific SUBSET in a specific order and shares already-
 * loaded deps), so eval ms is an UPPER BOUND per chunk; summing the subset a
 * given connector pulls overcounts shared deps. Transfer bytes are exact.
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "out");
mkdirSync(OUT, { recursive: true });
const LOGIN = process.env.LOGIN_URL ?? "https://login.127.0.0.1.nip.io:9443";
// The embed page URL needs OAuth params; any valid authorize URL works, but the
// page only needs to LOAD embed.js + be same-origin as the chunks. We use a
// minimal /oauth2/auth — it 200s and serves embed.js even without a live flow.
const EMBED_URL = process.env.EMBED_URL ?? `${LOGIN}/oauth2/auth`;

// Resolve target chunks from the live crawl inventory.
const TARGET_PREFIXES = [
  ["index.KP", "viem crypto (noble/secp256k1 signing primitives)"],
  ["core.", "@reown/appkit + WalletConnect core"],
  ["index.DyD", "Coinbase Wallet SDK"],
  ["index.es.", "WalletConnect sign-client"],
  ["basic.", "WalletConnect/web3modal basic"],
  ["w3m-modal.", "WalletConnect modal (web3modal)"],
];
function targets() {
  const inv = readFileSync(process.env.CHUNK_INVENTORY || "/tmp/chunk-inventory.txt", "utf8")
    .split("\n")
    .filter((l) => l.includes("raw="))
    .map((l) => ({
      name: l.split(" ")[0],
      raw: Number(/raw=(\d+)/.exec(l)?.[1] || 0),
      gz: Number(/gzipwire=(\d+)/.exec(l)?.[1] || 0),
    }));
  const rows = [];
  for (const [p, role] of TARGET_PREFIXES) {
    const hit = inv.find((c) => c.name.startsWith(p));
    if (hit) rows.push({ ...hit, role });
  }
  return rows;
}

async function importChunkAndTrace(ctx, chunkUrl) {
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);
  await client.send("Security.enable").catch(() => {});
  await client.send("Security.setIgnoreCertificateErrors", { ignore: true }).catch(() => {});
  await client.send("Network.enable");

  // transfer bytes for the chunk + any deps it pulls, keyed by reqId.
  const reqUrl = new Map();
  const transfers = [];
  client.on("Network.requestWillBeSent", (e) => reqUrl.set(e.requestId, e.request.url));
  client.on("Network.loadingFinished", (e) => {
    const u = reqUrl.get(e.requestId);
    if (u && u.includes("/static/js/")) transfers.push({ url: u, wire: e.encodedDataLength });
  });

  await page.goto(EMBED_URL, { waitUntil: "domcontentloaded" });
  // wait a beat for embed.js itself to settle so its bytes aren't attributed.
  await page.waitForTimeout(800);
  transfers.length = 0; // reset: only count what the import below pulls
  reqUrl.clear();

  // trace just the import
  const events = [];
  const onData = (ev) => events.push(...(ev.value || []));
  client.on("Tracing.dataCollected", onData);
  await client.send("Tracing.start", {
    categories:
      "devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute,disabled-by-default-v8.cpu_profiler",
    transferMode: "ReportEvents",
  });

  const wall = await page.evaluate(async (u) => {
    const t0 = performance.now();
    let err = null;
    try {
      await import(/* @vite-ignore */ u);
    } catch (e) {
      err = String(e).slice(0, 200);
    }
    return { evalWallMs: +(performance.now() - t0).toFixed(1), err };
  }, chunkUrl);

  await page.waitForTimeout(300);
  const done = new Promise((res) => client.once("Tracing.tracingComplete", res));
  await client.send("Tracing.end");
  await done;
  client.off("Tracing.dataCollected", onData);

  // sum v8 compile + eval time in the trace window (the page only did the import)
  let compileMs = 0,
    evalMs = 0,
    funcMs = 0;
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    if (/[Cc]ompile/.test(ev.name)) compileMs += ev.dur;
    else if (/EvaluateScript/.test(ev.name)) evalMs += ev.dur;
    else if (/FunctionCall/.test(ev.name)) funcMs += ev.dur;
  }
  const wireTotal = transfers.reduce((s, t) => s + t.wire, 0);

  await page.close();
  return {
    evalWallMs: wall.evalWallMs,
    importError: wall.err,
    compileMs: +(compileMs / 1000).toFixed(1),
    evaluateScriptMs: +(evalMs / 1000).toFixed(1),
    functionCallMs: +(funcMs / 1000).toFixed(1),
    v8TotalMs: +((compileMs + evalMs + funcMs) / 1000).toFixed(1),
    pulledChunks: transfers.length,
    pulledWireBytes: wireTotal,
  };
}

async function main() {
  const tgts = targets();
  console.log(`chunk-eval: import ${tgts.length} chunks in embed origin; embed=${EMBED_URL}`);
  const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  const results = [];
  for (const t of tgts) {
    const url = `${LOGIN}/login/static/js/${t.name}`;
    let r;
    try {
      r = await importChunkAndTrace(ctx, url);
    } catch (e) {
      r = { error: String(e) };
    }
    results.push({ file: t.name, role: t.role, rawBytes: t.raw, gzipWireBytes: t.gz, ...r });
    console.log(
      `  ${t.name.padEnd(22)} raw=${(t.raw / 1024).toFixed(0)}KB gzip=${(t.gz / 1024).toFixed(0)}KB ` +
        `v8=${r.v8TotalMs ?? "?"}ms (compile=${r.compileMs ?? "?"} eval=${r.evaluateScriptMs ?? "?"}) ` +
        `wall=${r.evalWallMs ?? "?"}ms pulled=${r.pulledChunks ?? 0}chunks/${((r.pulledWireBytes ?? 0) / 1024).toFixed(0)}KB` +
        (r.importError ? " importErr" : "")
    );
  }

  await browser.close();
  const out = {
    approach: "B (no wallet — import each chunk in the embed origin, trace v8 compile+eval)",
    caveat:
      "Transfer (gzipWireBytes) is exact. v8TotalMs is parse+compile+top-level-eval of the chunk imported in isolation in the real origin (deps resolve); it's an UPPER BOUND per chunk and double-counts deps shared between chunks. The real connect imports a SUBSET per connector (Coinbase tile -> Coinbase SDK + viem-crypto; WalletConnect tile -> @reown/appkit core + WC sign-client + basic + modal). importError!=null means top-level eval still threw (some chunks expect a host env), so their v8 ms is a floor.",
    login: LOGIN,
    embed: EMBED_URL,
    results,
  };
  writeFileSync(join(OUT, "chunk-eval.json"), JSON.stringify(out, null, 2));
  console.log(`Wrote ${join(OUT, "chunk-eval.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
