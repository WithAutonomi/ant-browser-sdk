// SDK builds against mainnet, side by side. Each arm is a built SDK `dist/`,
// served on its own local origin (the media worker registers at "/"), with
// harness.js. Every sample is a fresh browser context that opens the page,
// which connects with AutonomiClient.connect(); once connected, and 3 s more
// as a visitor would, the sample either downloads a public file with
// download() or streams try.autonomi.com's video with createMediaSource().
// The order of the arms rotates each round. Prints one JSON line per sample.
//
//   BROWSER=chromium|webkit node ab.mjs download:<address>|stream ROUNDS OUT.jsonl NAME=DIST...
import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PLAYWRIGHT = "/Users/mick/RustroverProjects/try-autonomi-manifests/node_modules/playwright/index.mjs";
const VIDEO_MANIFEST = "/Users/mick/RustroverProjects/try-autonomi-manifests/content/manifests/video.ant";
const HERE = dirname(fileURLToPath(import.meta.url));
const VISITOR_WAIT_MS = 3000;
const CONNECT_DEADLINE_MS = 60_000;
const DOWNLOAD_DEADLINE_MS = 900_000;
const STREAM_DEADLINE_MS = 180_000;
const STATS_INTERVAL_MS = 250;
const LAG_PROBE_MS = 50;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".ant": "application/octet-stream" };

const [mode, roundsArg, out, ...armArgs] = process.argv.slice(2);
const address = mode.startsWith("download:") ? mode.slice("download:".length) : undefined;
if (!address && mode !== "stream") throw Error("mode is download:<address> or stream");
const engine = process.env.BROWSER ?? "chromium";
const arms = armArgs.map(arg => { const [name, dist] = arg.split("="); return { name, dist }; });

// One origin per arm: the page, harness, SDK dist, media worker and manifest.
function serve(dist) {
  const server = http.createServer((req, res) => {
    const path = normalize(new URL(req.url, "http://x").pathname);
    let file;
    if (path === "/") file = join(HERE, "index.html");
    else if (path === "/harness.js") file = join(HERE, "harness.js");
    else if (path === "/video.ant") file = VIDEO_MANIFEST;
    else if (path === "/autonomi-stream-sw.js") file = join(dist, "autonomi-stream-sw.js");
    else if (path.startsWith("/sdk/")) file = join(dist, path.slice("/sdk/".length));
    if (!file || (path.startsWith("/sdk/") && !file.startsWith(dist))) { res.writeHead(404).end(); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

// Bytes received and peer connections created, holding only open connections
// (Chrome caps a page at 500 live ones), and main-thread lag.
function instrument({ intervalMs, lagProbeMs }) {
  const lags = [];
  let expected = performance.now() + lagProbeMs;
  setInterval(() => { const now = performance.now(); lags.push(Math.max(0, now - expected)); expected = now + lagProbeMs; }, lagProbeMs);
  window.__lagStart = () => { lags.length = 0; };
  window.__lag = () => lags.reduce((a, b) => a + b, 0) / 1000;
  const Native = window.RTCPeerConnection;
  const open = new Set();
  const counted = new WeakMap();
  let total = 0, created = 0;
  async function sample(pc) {
    try {
      let bytes = 0;
      (await pc.getStats()).forEach(s => { if (s.type === "transport" && typeof s.bytesReceived === "number") bytes += s.bytesReceived; });
      const before = counted.get(pc) ?? 0;
      if (bytes > before) { total += bytes - before; counted.set(pc, bytes); }
    } catch {}
  }
  setInterval(() => open.forEach(sample), intervalMs);
  window.__rtc = async () => { await Promise.all([...open].map(sample)); return { bytes: total, connections: created }; };
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      created++;
      open.add(this);
      this.addEventListener("connectionstatechange", () => { if (this.connectionState === "failed" || this.connectionState === "closed") open.delete(this); });
    }
    close() { sample(this); open.delete(this); return super.close(); }
  };
}

const withDeadline = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${what} deadline`)), ms); })]).finally(() => clearTimeout(timer));
};

const servers = await Promise.all(arms.map(arm => serve(arm.dist)));
const { [engine]: browserType } = await import(PLAYWRIGHT);
const browser = await browserType.launch({ headless: true,
  ...(engine === "chromium" ? { args: ["--force-fieldtrials=WebRTC-NoSdpMangleUfrag/Enabled/", "--autoplay-policy=no-user-gesture-required"] } : {}) });
writeFileSync(out, "");
try {
  for (let round = 0; round < Number(roundsArg); round++) {
    for (const index of arms.map((_, i) => (i + round) % arms.length)) {
      const arm = arms[index];
      const context = await browser.newContext();
      await context.addInitScript(instrument, { intervalMs: STATS_INTERVAL_MS, lagProbeMs: LAG_PROBE_MS });
      const page = await context.newPage();
      const errors = [], wasm = new Set(), tasks = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname.endsWith(".wasm")) tasks.push(response.body().then(body => wasm.add(createHash("sha256").update(body).digest("hex").slice(0, 16))));
      });
      const sample = { round, arm: arm.name, engine, mode: address ? "download" : "stream", startedAt: new Date().toISOString() };
      try {
        await page.goto(`${servers[index].origin}/`);
        await page.waitForFunction(() => window.__harness && window.__harness.state !== "connecting", null, { timeout: CONNECT_DEADLINE_MS });
        if (await page.evaluate(() => window.__harness.state) !== "connected") throw Error(await page.evaluate(() => window.__harness.error));
        sample.connectMs = Math.round(await page.evaluate(() => window.__harness.connectMs));
        await page.waitForTimeout(VISITOR_WAIT_MS);
        const before = await page.evaluate(async () => { window.__lagStart(); return window.__rtc(); });
        if (address) {
          const result = await withDeadline(page.evaluate(address => window.__harness.download({ address }), address), DOWNLOAD_DEADLINE_MS, "download");
          Object.assign(sample, { ms: Math.round(result.ms), bytes: result.bytes, sha256: result.sha256 });
        } else {
          const result = await withDeadline(page.evaluate(() => window.__harness.run({ manifestUrl: "./video.ant" })), STREAM_DEADLINE_MS, "stream");
          Object.assign(sample, { firstFrameMs: Math.round(result.firstFrameMs), playedIn10s: result.playedIn10s, seekMs: Math.round(result.seekMs), waiting: result.waiting });
        }
        const after = await page.evaluate(async () => ({ ...(await window.__rtc()), busy: window.__lag() }));
        Object.assign(sample, { rx: after.bytes - before.bytes, connections: after.connections - before.connections, busy: Math.round(after.busy * 10) / 10 });
        sample.ok = address ? true : sample.playedIn10s >= 5;
      } catch (error) {
        sample.ok = false;
        sample.error = String(error?.message ?? error).slice(0, 300);
      } finally {
        await Promise.allSettled(tasks);
        Object.assign(sample, { pageErrors: errors, wasm: [...wasm] });
        await context.close().catch(() => {});
      }
      console.log(JSON.stringify(sample));
      appendFileSync(out, JSON.stringify(sample) + "\n");
    }
  }
} finally {
  await browser.close();
  servers.forEach(({ server }) => server.close());
}
