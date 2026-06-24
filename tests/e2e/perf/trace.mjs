// One tracing iteration (CDP Tracing, devtools.timeline categories) to get the
// real main-thread breakdown: script-eval per URL, the embed top-window cost,
// and a sanity check on the long-task finding.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "out");
const DEMO_URL = process.env.DEMO_URL ?? "https://login-demo.cv.127.0.0.1.nip.io:9443";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const client = await ctx.newCDPSession(page);

const events = [];
client.on("Tracing.dataCollected", (e) => events.push(...(e.value || [])));

await client.send("Tracing.start", {
  categories:
    "devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute,disabled-by-default-v8.cpu_profiler,blink.user_timing",
  transferMode: "ReportEvents",
  options: "sampling-frequency=10000",
});

await page.goto(DEMO_URL + "/", { waitUntil: "load" });
await page.getByText("Login with Ethereum Wallet").click();
// wait for picker chrome
for (let i = 0; i < 60; i++) {
  let ok = false;
  for (const fr of page.frames())
    if (fr.url().includes("/login?"))
      ok = await fr.evaluate(() => /Continue with a wallet/.test(document.body?.innerText || "")).catch(() => false);
  if (ok) break;
  await sleep(100);
}
await sleep(2000);

const done = new Promise((res) => client.once("Tracing.tracingComplete", res));
await client.send("Tracing.end");
await done;
await browser.close();

// Summarize: bucket EvaluateScript / FunctionCall / v8.compile by script URL,
// plus Layout / RecalculateStyles / Paint, and find tasks (RunTask) > 50ms.
const byKind = {};
const byScript = {};
const longTasks = [];
let minTs = Infinity, maxTs = -Infinity;

// Build a quick map: track durations of complete events (ph 'X') with dur.
for (const e of events) {
  if (e.ts < minTs) minTs = e.ts;
  if (e.ts > maxTs) maxTs = e.ts;
  if (e.ph !== "X" || typeof e.dur !== "number") continue;
  const name = e.name;
  byKind[name] = (byKind[name] || 0) + e.dur;
  const url =
    e.args?.data?.url ||
    e.args?.data?.fileName ||
    e.args?.data?.functionName ||
    null;
  if (/EvaluateScript|FunctionCall|v8\.compile|CompileScript|CompileCode/.test(name) && url) {
    const key = String(url).split("/").pop().split("?")[0] || url;
    byScript[key] = (byScript[key] || 0) + e.dur;
  }
  if (name === "RunTask" && e.dur > 50000) longTasks.push(Math.round(e.dur / 1000));
}

const top = (obj, n) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `  ${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`);

const lines = [];
lines.push(`TRACE SUMMARY (single iter, ${events.length} events, ~${Math.round((maxTs - minTs) / 1000)}ms window)`);
lines.push(`\n-- Main-thread time by activity (ms, top 12) --`);
lines.push(...top(byKind, 12));
lines.push(`\n-- Script eval/compile time by file (ms, top 12) --`);
lines.push(...top(byScript, 12));
lines.push(`\n-- RunTask > 50ms (long tasks): ${longTasks.length} found ${longTasks.length ? "(" + longTasks.sort((a, b) => b - a).join(", ") + " ms)" : ""}`);

const out = lines.join("\n");
writeFileSync(join(OUT, "trace-summary.txt"), out);
writeFileSync(join(OUT, "trace-kinds.json"), JSON.stringify({ byKind, byScript, longTasks }, null, 2));
console.log(out);
