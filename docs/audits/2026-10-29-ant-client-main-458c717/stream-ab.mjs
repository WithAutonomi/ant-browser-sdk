// Streaming start, the SDK's createMediaSource() against try.autonomi.com's own
// player, same video and core. Every sample is a fresh Chromium context that
// opens the page, waits until its client has connected, then 3 s more as a
// visitor would, and starts the video: the SDK harness calls
// createMediaSource(), try's page gets a click on the video's Stream button.
// Both are timed from that moment to the first decoded frame
// (requestVideoFrameCallback), then ten seconds of playback and a seek to 85%
// of the video: beyond the 32 MiB read-ahead window from the start, and before
// the last record, which streaming mode fetches with the first. The variant order rotates each round.
// Usage: node compare.mjs --out results.json --rounds 12 --variant name=kind=url ...
//   kind is "sdk" (the SDK audit's harness page) or "try" (a packaged try site)
import * as playwright from "/Users/mick/RustroverProjects/try-autonomi-manifests/node_modules/playwright/index.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const VISITOR_WAIT_MS = 3000;
const PLAYBACK_MS = 10_000;
const FIRST_FRAME_DEADLINE_MS = 120_000;
const SEEK_DEADLINE_MS = 60_000;
const SEEK_FRACTION = 0.85;

const { values } = parseArgs({ options: { variant: { type: "string", multiple: true }, rounds: { type: "string", default: "12" }, out: { type: "string" } } });
const variants = values.variant.map(item => { const [name, kind, url] = item.split("="); return { name, kind, url }; });
const catalogue = JSON.parse(await readFile("/Users/mick/RustroverProjects/try-autonomi-manifests/content/featured.live.json", "utf8"));
const video = catalogue.files.find(file => file.id === "video");
// BROWSER=webkit runs Playwright's WebKit; the default is Chromium.
const engine = process.env.BROWSER ?? "chromium";
const browser = await playwright[engine].launch({ headless: true,
  ...(engine === "chromium" ? { args: ["--force-fieldtrials=WebRTC-NoSdpMangleUfrag/Enabled/", "--autoplay-policy=no-user-gesture-required"] } : {}) });
const report = { startedAt: new Date().toISOString(), engine, browser: browser.version(), rounds: Number(values.rounds), variants, video: { name: video.name, size: video.size },
  scriptSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"), samples: [] };
const save = () => writeFile(values.out, JSON.stringify(report, null, 2) + "\n");

// The seek is measured as the SDK harness measures it.
async function seekTo(page, selector, fraction, deadline) {
  return page.evaluate(async ({ selector, fraction, deadline }) => {
    const element = document.querySelector(selector);
    const target = element.duration * fraction;
    const began = performance.now();
    const frame = new Promise(resolve => {
      const onFrame = (at, metadata) => (Math.abs(metadata.mediaTime - target) < 1 ? resolve(at - began) : element.requestVideoFrameCallback(onFrame));
      element.requestVideoFrameCallback(onFrame);
    });
    element.currentTime = target;
    await element.play();
    return Promise.race([frame, new Promise((_, reject) => setTimeout(() => reject(Error("seek frame deadline")), deadline))]);
  }, { selector, fraction, deadline });
}

async function sdkSample(page, variant) {
  await page.goto(variant.url);
  await page.waitForFunction(() => window.__harness && window.__harness.state !== "connecting", null, { timeout: 60_000 });
  if (await page.evaluate(() => window.__harness.state) !== "connected") throw Error(await page.evaluate(() => window.__harness.error));
  await page.waitForTimeout(VISITOR_WAIT_MS);
  const result = await page.evaluate(() => window.__harness.run({ manifestUrl: "./video.ant" }));
  return { firstFrameMs: result.firstFrameMs, playedIn10s: result.playedIn10s, seekMs: result.seekMs, waiting: result.waiting };
}

async function trySample(page, variant) {
  await page.goto(variant.url);
  await page.waitForFunction(() => window.__tryAutonomiDebug?.manifestsReady && ["ready", "live"].includes(document.querySelector("#network-status").dataset.state), null, { timeout: 60_000 });
  await page.waitForFunction(() => ["connected", "failed"].includes(window.__tryAutonomiDebug.client), null, { timeout: 60_000 });
  if (await page.evaluate(() => window.__tryAutonomiDebug.client) !== "connected") throw Error("the page's client did not connect");
  await page.waitForTimeout(VISITOR_WAIT_MS);
  await page.evaluate(() => {
    const cmp = window.__cmp = { clickAt: null, frames: [], waiting: 0 };
    document.addEventListener("click", event => {
      if (event.target.closest?.(".featured-stream")) cmp.clickAt ??= performance.now();
    }, true);
    const seen = new WeakSet();
    const watch = element => {
      if (seen.has(element)) return;
      seen.add(element);
      element.addEventListener("waiting", () => cmp.waiting++);
      element.requestVideoFrameCallback((at, metadata) => cmp.frames.push({ at, mediaTime: metadata.mediaTime }));
    };
    new MutationObserver(() => document.querySelectorAll("#preview video").forEach(watch)).observe(document.querySelector("#preview"), { childList: true, subtree: true });
  });
  await page.locator("#featured-list li").filter({ hasText: video.name }).locator(".featured-stream").click();
  await page.waitForFunction(() => window.__cmp.frames.length > 0 || window.__tryAutonomi?.error, null, { timeout: FIRST_FRAME_DEADLINE_MS });
  const error = await page.evaluate(() => window.__tryAutonomi?.error);
  if (error) throw Error(error);
  const firstFrameMs = await page.evaluate(() => window.__cmp.frames[0].at - window.__cmp.clickAt);
  const start = await page.evaluate(() => document.querySelector("#preview video").currentTime);
  await page.waitForTimeout(PLAYBACK_MS);
  const playedIn10s = await page.evaluate(start => document.querySelector("#preview video").currentTime - start, start);
  const seekMs = await seekTo(page, "#preview video", SEEK_FRACTION, SEEK_DEADLINE_MS);
  return { firstFrameMs, playedIn10s, seekMs, waiting: await page.evaluate(() => window.__cmp.waiting) };
}

try {
  for (let round = 1; round <= report.rounds; round++) {
    const shift = round % variants.length;
    for (const variant of [...variants.slice(shift), ...variants.slice(0, shift)]) {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [], wasm = new Set(), tasks = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname.endsWith(".wasm")) tasks.push(response.body().then(body => wasm.add(createHash("sha256").update(body).digest("hex"))));
      });
      const sample = { round, variant: variant.name, startedAt: new Date().toISOString() };
      try {
        Object.assign(sample, await (variant.kind === "sdk" ? sdkSample : trySample)(page, variant));
        sample.status = sample.playedIn10s >= 5 ? "passed" : "failed";
      } catch (error) {
        sample.status = "failed";
        sample.error = String(error.message ?? error);
      } finally {
        await Promise.allSettled(tasks);
        Object.assign(sample, { pageErrors: errors, wasm: [...wasm] });
        await context.close();
      }
      console.log(JSON.stringify(sample));
      report.samples.push(sample);
      await save();
    }
  }
  report.finishedAt = new Date().toISOString();
  await save();
} finally {
  await browser.close();
}
