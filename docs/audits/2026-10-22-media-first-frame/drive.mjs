// Alternating fresh-context samples of the harness on each served variant.
// Usage: node drive.mjs --out results.json --runs 3 --variant name=url ...
import { chromium } from "/Users/mick/RustroverProjects/try-autonomi-manifests/node_modules/playwright/index.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { variant: { type: "string", multiple: true }, runs: { type: "string", default: "3" }, out: { type: "string" }, browser: { type: "string", default: "chromium" } } });
const variants = values.variant.map(item => { const [name, url] = item.split("="); return { name, url }; });
const browser = await chromium.launch({ headless: true, args: ["--force-fieldtrials=WebRTC-NoSdpMangleUfrag/Enabled/", "--autoplay-policy=no-user-gesture-required"] });
const report = { startedAt: new Date().toISOString(), browser: browser.version(), variants, runs: Number(values.runs),
  scriptSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"), samples: [] };
const out = resolve(values.out);
await mkdir(dirname(out), { recursive: true });
try {
  for (let round = 1; round <= report.runs; round++) {
    for (const variant of round % 2 ? variants : [...variants].reverse()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      const wasm = new Set();
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", async response => { if (new URL(response.url()).pathname.endsWith(".wasm")) wasm.add(createHash("sha256").update(await response.body()).digest("hex")); });
      const sample = { round, variant: variant.name };
      try {
        await page.goto(variant.url);
        await page.waitForFunction(() => window.__harness && window.__harness.state !== "connecting", null, { timeout: 60_000 });
        if (await page.evaluate(() => window.__harness.state) !== "connected") throw Error(await page.evaluate(() => window.__harness.error));
        // As a visitor reads the page: the remaining seeds connect in the background.
        await page.waitForTimeout(3000);
        Object.assign(sample, await page.evaluate(() => window.__harness.run({ manifestUrl: "./video.ant" })));
        sample.status = sample.playedIn10s >= 5 ? "passed" : "failed";
      } catch (error) {
        sample.status = "failed";
        sample.error = String(error.message ?? error);
      } finally {
        sample.pageErrors = errors;
        sample.wasm = [...wasm];
        await context.close();
      }
      console.log(JSON.stringify(sample));
      report.samples.push(sample);
      await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    }
  }
} finally {
  await browser.close();
}
