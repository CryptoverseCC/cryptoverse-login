// @ts-check
/**
 * Connect-time chunk-load + eval capture, driving the REAL product connect path
 * (Approach A, salvaged). A real MetaMask is bootstrapped via dappwright (headed
 * under Xvfb); we drive demo RP -> IdP, then re-issue the iframe's lost init()
 * over a freshly-built Comlink endpoint (the iframe's own init() is dropped by a
 * startup race — see README "root cause"), which makes the parent build the
 * wagmi config + EIP-6963-discover the wallets. We then call connect() to a
 * chosen connector, which triggers the lazy import of the wallet-SDK chunks
 * (viem crypto / Coinbase SDK / @reown+WC), and capture, over the connect window:
 *   - per-chunk transfer bytes (CDP Network encodedDataLength)
 *   - per-chunk v8 compile+eval ms (CDP Tracing)
 *   - main-thread long tasks during connect
 *
 * We do NOT require the MetaMask APPROVE popup to succeed: the chunk import +
 * createConfig + connector instantiation all happen BEFORE the user approves, so
 * the connect-time JS cost is captured even when the popup is auto-dismissed or
 * times out. (Popup approval — and thus a full sign + redirect — is flaky to
 * automate for MM 13.x headless; the sign cost is reported separately if it
 * lands, else flagged.) Hard per-step timeouts ensure the script never hangs.
 *
 * Env: CONNECTOR=metamask|coinbase (default metamask), ITERS (default 1),
 *      DO_SIGN=1 to also attempt approve+sign (off by default — flaky).
 */
import dappwright, { MetaMaskWallet } from "@tenkeylabs/dappwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "out");
mkdirSync(OUT, { recursive: true });
const DEMO = process.env.DEMO_URL ?? "https://login-demo.cv.127.0.0.1.nip.io:9443";
const CONNECTOR = (process.env.CONNECTOR ?? "metamask").toLowerCase();
const ITERS = Number(process.env.ITERS ?? 1);
const DO_SIGN = process.env.DO_SIGN === "1";
const COMLINK_URL = "/login/static/js/comlink.DzyJ9yJa.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((res) => setTimeout(() => res({ __timeout: label }), ms)),
  ]);

async function runIteration(context, wallet, idx) {
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send("Security.enable").catch(() => {});
  await client.send("Security.setIgnoreCertificateErrors", { ignore: true }).catch(() => {});
  await client.send("Network.enable");

  const reqUrl = new Map();
  const chunkLoads = [];
  client.on("Network.requestWillBeSent", (e) => reqUrl.set(e.requestId, e.request.url));
  client.on("Network.responseReceived", (e) => {
    const r = reqUrl.get(e.requestId);
    if (typeof r === "string") {
      const h = {};
      for (const [k, v] of Object.entries(e.response.headers || {})) h[k.toLowerCase()] = v;
      reqUrl.set(e.requestId, { url: r, enc: h["content-encoding"] || "" });
    }
  });
  let collecting = false;
  client.on("Network.loadingFinished", (e) => {
    const r = reqUrl.get(e.requestId);
    const url = typeof r === "string" ? r : r?.url;
    if (!collecting || !url || !url.includes("/static/js/")) return;
    chunkLoads.push({
      chunk: url.split("/").pop().split("?")[0],
      wire: e.encodedDataLength,
      enc: typeof r === "object" ? r.enc : "",
    });
  });

  // 1. demo -> login button -> IdP
  await page.goto(DEMO + "/", { waitUntil: "load" });
  await page.getByText("Login with Ethereum Wallet").click();
  await sleep(3500); // let embed + iframe settle so the parent Comlink endpoint is up

  let frame = null;
  for (const fr of page.frames()) if (fr.url().includes("/login?")) frame = fr;
  if (!frame) throw new Error("login iframe not found");

  // 2. Re-issue init() over a fresh Comlink endpoint (the iframe's own was lost).
  const t0 = Date.now();
  const initResult = await frame.evaluate(async (comlinkUrl) => {
    const Comlink = await import(comlinkUrl);
    const windowEndpoint = (target, self = window, targetOrigin = "*") => ({
      postMessage: (msg, transfer) => target.postMessage(msg, targetOrigin, transfer),
      addEventListener: self.addEventListener.bind(self),
      removeEventListener: self.removeEventListener.bind(self),
    });
    const wrap = Comlink.w || Comlink.wrap;
    const remote = wrap(windowEndpoint(window.parent));
    const ld = JSON.parse(document.getElementById("login-data")?.textContent || "{}");
    const s = performance.now();
    const resp = await remote.init({
      walletConnectProjectId: ld.walletConnectProjectId,
      appName: ld.metadata?.app,
    });
    window.__remote = remote;
    return {
      initMs: +(performance.now() - s).toFixed(1),
      wallets: (resp?.wallets ?? []).map((w) => ({ id: w.id, name: w.name })),
    };
  }, COMLINK_URL).catch((e) => ({ err: String(e) }));
  const initWall = Date.now() - t0;

  if (initResult.err || !initResult.wallets?.length) {
    await page.close();
    return { iter: idx, initWall, initResult, error: "init failed / no wallets" };
  }

  const target =
    initResult.wallets.find((w) => new RegExp(CONNECTOR, "i").test(w.name)) ||
    initResult.wallets[0];

  // 3. Start trace + begin collecting chunk loads, then fire connect.
  const events = [];
  const onData = (ev) => events.push(...(ev.value || []));
  client.on("Tracing.dataCollected", onData);
  await client.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute",
    transferMode: "ReportEvents",
  });
  collecting = true;
  const connectStart = Date.now();

  // Fire connect WITHOUT awaiting the popup; we just need the chunk import +
  // createConfig + connector instantiation, which precede eth_requestAccounts.
  const connectPromise = frame
    .evaluate(async (id) => {
      const s = performance.now();
      const r = await window.__remote.connect({ id });
      return { connectMs: +(performance.now() - s).toFixed(1), r };
    }, target.id)
    .catch((e) => ({ err: String(e) }));

  // Optionally approve the popup (flaky). Give the chunk imports ~6s regardless.
  let approveErr = null;
  let connectRes = null;
  if (DO_SIGN) {
    await sleep(1500);
    try {
      await withTimeout(wallet.approve(), 15000, "approve");
    } catch (e) {
      approveErr = String(e).slice(0, 160);
    }
    connectRes = await withTimeout(connectPromise, 20000, "connect");
  } else {
    // Just let the imports run; the connect promise will resolve when the popup
    // is approved (which we won't do) OR we time out the WAIT (not the promise).
    connectRes = await withTimeout(connectPromise, 8000, "connect-noapprove");
  }
  const connectWall = Date.now() - connectStart;

  await sleep(400);
  const done = new Promise((res) => client.once("Tracing.tracingComplete", res));
  await client.send("Tracing.end");
  await done;
  client.off("Tracing.dataCollected", onData);
  collecting = false;

  // attribute v8 compile+eval per chunk file + long tasks
  const byScript = {};
  let longTasks = [];
  for (const ev of events) {
    if (ev.ph !== "X" || typeof ev.dur !== "number") continue;
    const u = ev.args?.data?.url || ev.args?.data?.fileName || "";
    if (/EvaluateScript|FunctionCall|[Cc]ompile/.test(ev.name) && u) {
      const k = String(u).split("/").pop().split("?")[0];
      byScript[k] = (byScript[k] || 0) + ev.dur;
    }
    if (ev.name === "RunTask" && ev.dur > 50000) longTasks.push(Math.round(ev.dur / 1000));
  }
  const scriptMs = Object.fromEntries(
    Object.entries(byScript)
      .map(([k, v]) => [k, +(v / 1000).toFixed(1)])
      .sort((a, b) => b[1] - a[1])
  );

  // dedupe chunkLoads by chunk (keep max wire)
  const chunkMap = new Map();
  for (const c of chunkLoads) {
    const prev = chunkMap.get(c.chunk);
    if (!prev || c.wire > prev.wire) chunkMap.set(c.chunk, c);
  }
  const chunks = [...chunkMap.values()].sort((a, b) => b.wire - a.wire);
  const chunkWireTotal = chunks.reduce((s, c) => s + c.wire, 0);

  // sign (optional)
  let sign = null;
  if (DO_SIGN && !connectRes?.__timeout && !connectRes?.err) {
    const idVisible = await frame
      .evaluate(() => !!document.querySelector('[aria-label^="Sign in with "]'))
      .catch(() => false);
    if (idVisible) {
      const signStart = Date.now();
      await frame.evaluate(() => document.querySelector('[aria-label^="Sign in with "]')?.click()).catch(() => {});
      await sleep(1500);
      let signErr = null,
        loggedIn = false;
      try {
        await withTimeout(wallet.sign(), 15000, "sign");
      } catch (e) {
        signErr = String(e).slice(0, 160);
      }
      try {
        await page.waitForURL(/demo\.127\.0\.0\.1/, { timeout: 25000 });
        loggedIn = /Success/i.test(await page.title());
      } catch (e) {
        signErr = (signErr || "") + " redirect-timeout";
      }
      sign = { signWall: Date.now() - signStart, signErr, loggedIn };
    }
  }

  await page.close().catch(() => {});
  return {
    iter: idx,
    connector: target.name,
    initWall,
    initMs: initResult.initMs,
    walletsDiscovered: initResult.wallets.map((w) => w.name),
    connectWall,
    connectRes: connectRes?.__timeout
      ? { note: "connect promise still pending at " + connectRes.__timeout + " (popup not approved) — chunk import already captured" }
      : connectRes,
    approveErr,
    chunkLoadsDuringConnect: chunks,
    chunkWireTotalBytes: chunkWireTotal,
    scriptEvalMsDuringConnect: scriptMs,
    longTasksDuringConnect: longTasks.sort((a, b) => b - a),
    sign,
  };
}

async function main() {
  console.log(
    `connect-chunks: connector=${CONNECTOR} iters=${ITERS} doSign=${DO_SIGN} (MM v${MetaMaskWallet.recommendedVersion})`
  );
  const [wallet, , context] = await dappwright.bootstrap("", {
    wallet: "metamask",
    version: MetaMaskWallet.recommendedVersion,
    seed: "elephant frog rib donate live collect uniform lamp inch urge dish wash",
    password: "selenium_tests", // pragma: allowlist secret
    headless: false,
  });

  const results = [];
  for (let i = 0; i < ITERS; i++) {
    process.stdout.write(`  iter ${i + 1}/${ITERS} ... `);
    try {
      const r = await runIteration(context, wallet, i);
      results.push(r);
      console.log(
        `init=${r.initMs ?? "?"}ms wallets=[${r.walletsDiscovered ?? r.initResult?.err}] ` +
          `connectChunks=${((r.chunkWireTotalBytes ?? 0) / 1024).toFixed(0)}KB ` +
          `longTasks=${r.longTasksDuringConnect?.length ?? "?"} ` +
          (r.sign ? `sign=${r.sign.signWall}ms loggedIn=${r.sign.loggedIn}` : "")
      );
    } catch (err) {
      console.log(`ERROR: ${err}`);
      results.push({ iter: i, error: String(err), stack: err?.stack?.slice(0, 400) });
    }
  }

  await context.close().catch(() => {});
  const outPath = join(OUT, "connect-chunks.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        approach:
          "A salvaged (real MetaMask; init re-issued over fresh Comlink to bypass the startup race that drops the iframe's own init)",
        connector: CONNECTOR,
        metamaskVersion: MetaMaskWallet.recommendedVersion,
        demo: DEMO,
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
