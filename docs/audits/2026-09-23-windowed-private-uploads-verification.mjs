import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

// Run after `npm run sync:wasm` and `npm run check`. Starts only a fresh local
// Anvil devnet and a Vite server on isolated ports, and stops both on exit.
// ANT_DEVNET selects the ant-devnet binary built at the node revision the bundled
// core pins; PLAYWRIGHT_CORE selects a playwright-core entry point.
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projects = dirname(sdk);
const { chromium } = await import(process.env.PLAYWRIGHT_CORE
  ?? `${projects}/ant-client-web-support/ant-core/browser-tests/node_modules/playwright-core/index.mjs`);
const { Wallet } = await import(`${sdk}/node_modules/ethers/lib.esm/index.js`);
const devnetBinary = process.env.ANT_DEVNET ?? `${projects}/ant-node-web-support/target/debug/ant-devnet`;

// Merkle candidate pools need sixteen distinct candidates.
const NODES = 20;
const DEVNET_PORT = 47500;
const VITE_PORT = 47573;
const MEBIBYTE = 1024 * 1024;
// Chromium enforces an overridden quota on IndexedDB writes, but its storage
// estimate still reports the unmodified quota. Uploads with the browser's estimate
// therefore end windows on QuotaExceededError; uploads with a matched estimate see
// a budget of about three 4 MiB records per window. The override applies to
// IndexedDB opened after it, so each windowed scenario starts in a fresh context.
const WINDOWED_QUOTA = 30 * MEBIBYTE;
const WINDOWED_FILE_BYTES = 40 * MEBIBYTE;
const DEMO_FILE_BYTES = MEBIBYTE;

const root = await mkdtemp(join(tmpdir(), "ant-windowed-uploads-"));
console.log(`Audit artifacts: ${root}`);
const nodes = await mkdtemp(`${root}/nodes-`);
const children = [];
function start(command, args, cwd, name) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(`${root}/${name}.log`);
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.push(child);
  return child;
}
start(devnetBinary, [
  "--nodes", String(NODES), "--data-dir", nodes, "--base-port", "47300", "--webrtc-direct",
  "--webrtc-direct-base-port", "47400", "--serve-port", String(DEVNET_PORT), "--enable-evm",
  "--enable-logging", "--log-level", "warn",
], root, "devnet");
start(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "examples/all-in-one/vite.config.ts",
  "--port", String(VITE_PORT), "--strictPort"], sdk, "vite");

async function ready(url) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (children.some((child) => child.exitCode !== null)) throw new Error("A test service exited");
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Service not ready: ${url}`);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let browser;
let profile;
const results = { provenance: JSON.parse(await readFile(`${sdk}/src/wasm/source.json`, "utf8")), nodes: NODES };
try {
  const info = await (await ready(`http://127.0.0.1:${DEVNET_PORT}/api/info`)).json();
  assert.equal(info.evm.network, "local-anvil");
  const manifest = await (await fetch(`http://127.0.0.1:${DEVNET_PORT}/api/browser-manifest.json`)).json();
  const endpoint = manifest.endpoints[0].multiaddr ?? manifest.endpoints[0];
  const origin = `http://127.0.0.1:${VITE_PORT}`;
  await ready(`${origin}/`);
  const key = Wallet.fromPhrase("test test test test test test test test test test test junk").privateKey;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const wasmHashes = new Set();
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm")) wasmHashes.add(sha256(await response.body()));
  });
  // Exercise the demo's anchor download fallback rather than an OS picker.
  await page.addInitScript(() => { delete window.showSaveFilePicker; });

  // 1. The demo uploads public and private files and reads each back.
  await page.goto(`${origin}/`);
  await page.locator("#bootstrap").fill(endpoint);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#connection").value.startsWith("Connected"), {}, { timeout: 60_000 });
  await page.locator("#payment-rpc").fill(info.evm.rpc_url);
  await page.locator("#wallet").fill(key);
  const logText = () => page.locator("#log").textContent();
  const waitForLog = async (pattern) => {
    await page.waitForFunction((source) => new RegExp(source).test(document.querySelector("#log").textContent)
      || /Error:|failed/i.test(document.querySelector("#log").textContent), pattern.source, { timeout: 300_000 });
    const log = await logText();
    assert.match(log, pattern, log);
  };
  const saveDownload = async (click) => {
    const downloading = page.waitForEvent("download", { timeout: 300_000 });
    await click();
    return readFile(await (await downloading).path());
  };

  const publicDemo = randomBytes(DEMO_FILE_BYTES);
  await page.locator("#upload-input").setInputFiles({ name: "public-demo.bin", mimeType: "application/octet-stream", buffer: publicDemo });
  await page.locator("#upload").click();
  await waitForLog(/Uploaded public-demo\.bin as [0-9a-f]{64}/);
  const publicDownloaded = await saveDownload(() => page.locator("#download").click());
  assert.equal(sha256(publicDownloaded), sha256(publicDemo));

  const privateDemo = randomBytes(DEMO_FILE_BYTES);
  await page.locator("#visibility").selectOption("private");
  await page.locator("#upload-input").setInputFiles({ name: "private-demo.bin", mimeType: "application/octet-stream", buffer: privateDemo });
  await page.locator("#upload").click();
  await waitForLog(/Uploaded private private-demo\.bin/);
  const dataMap = await saveDownload(() => page.locator("#save-datamap").click());
  assert.equal(await page.locator("#address").inputValue(), "");
  // Reload so the demo can read only through the saved .datamap file.
  await page.reload();
  await page.locator("#bootstrap").fill(endpoint);
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#connection").value.startsWith("Connected"), {}, { timeout: 60_000 });
  await page.locator("#datamap-input").setInputFiles({ name: "private-demo.bin.datamap", mimeType: "application/octet-stream", buffer: dataMap });
  await waitForLog(/Loaded the private DataMap for private-demo\.bin/);
  const privateDownloaded = await saveDownload(() => page.locator("#download").click());
  assert.equal(sha256(privateDownloaded), sha256(privateDemo));
  results.demo = { publicBytes: publicDemo.length, privateBytes: privateDemo.length, dataMapBytes: dataMap.length, matches: true };
  console.log("Demo public and private round trips match");

  // Open the page with the quota override in force before any IndexedDB use.
  async function quotaLimitedPage(context) {
    const limited = context.pages()[0] ?? await context.newPage();
    limited.on("pageerror", (error) => errors.push(String(error)));
    const cdp = await context.newCDPSession(limited);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: WINDOWED_QUOTA });
    await limited.goto(`${origin}/`);
    await limited.exposeFunction("auditLog", (value) => console.log(JSON.stringify(value)));
    return limited;
  }

  // 2. With an on-disk profile, as in ordinary browsing, deleted windows free their
  // quota at once and files larger than the quota upload in paid windows.
  profile = await chromium.launchPersistentContext(await mkdtemp(`${root}/profile-`), { headless: true });
  const windowedPage = await quotaLimitedPage(profile);
  results.windowed = await windowedPage.evaluate(async ({ sdk, endpoint, rpcUrl, key, fileBytes, enforcedQuota }) => {
    const { AutonomiClient, UploadError } = await import(`/@fs/${sdk}/dist/index.js`);
    const { createEthersPaymentProvider } = await import(`/@fs/${sdk}/dist/ethers.js`);
    const wallet = createEthersPaymentProvider({ privateKey: key, rpcUrl });
    const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    const randomFile = (name) => {
      const bytes = new Uint8Array(fileBytes);
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
      }
      return new File([bytes], name, { type: "application/octet-stream" });
    };
    const counting = () => {
      const counter = { payments: 0, merkle: 0 };
      counter.provider = {
        pay(...args) { counter.payments++; return wallet.pay(...args); },
        payMerkle(...args) { counter.merkle++; return wallet.payMerkle(...args); },
        recover: wallet.recover, recoverMerkle: wallet.recoverMerkle,
      };
      return counter;
    };
    // A terminal progress event repeats the last message, so count distinct windows.
    const windowsOf = (events) => [...new Set(events.filter((message) => /^Preparing storage for .* records \d+-\d+$/u.test(message)))];
    const browserEstimate = StorageManager.prototype.estimate;
    const useEstimate = (matched) => {
      StorageManager.prototype.estimate = matched
        ? async function () { return { ...await browserEstimate.call(this), quota: enforcedQuota }; }
        : browserEstimate;
    };
    const client = await AutonomiClient.connect(endpoint);
    const outcome = { browserEstimate: await navigator.storage.estimate(), enforcedQuota };
    try {
      for (const [label, estimate, options] of [
        ["public", "browser", { paymentMode: "single" }],
        ["private", "matched", { visibility: "private" }],
        ["merkle", "matched", { paymentMode: "merkle" }],
      ]) {
        useEstimate(estimate === "matched");
        const file = randomFile(`${label}-windowed.bin`);
        const counter = counting();
        const events = [];
        const started = performance.now();
        const uploaded = await client.upload(file, { ...options, payment: counter.provider,
          onProgress: (event) => events.push(event.message) });
        const downloaded = await client.download(uploaded.file);
        outcome[label] = {
          estimate, records: uploaded.records, windows: windowsOf(events), payments: counter.payments, merklePayments: counter.merkle,
          paymentMode: uploaded.paymentMode, storageCostAtto: uploaded.storageCostAtto,
          address: uploaded.file.address ?? null, dataMapBytes: uploaded.file.dataMap?.byteLength ?? null,
          matches: await digest(downloaded.bytes) === await digest(await file.arrayBuffer()),
          ms: Math.round(performance.now() - started),
        };
        window.auditLog({ label, ...outcome[label] });
      }

      // Stop before the second window is paid, then resume from its staged records.
      useEstimate(true);
      const file = randomFile("resumed-windowed.bin");
      const counter = counting();
      const controller = new AbortController();
      const events = [];
      let recovery;
      try {
        await client.upload(file, { signal: controller.signal, paymentMode: "single", payment: counter.provider,
          onProgress: (event) => {
            events.push(event.message);
            if (windowsOf(events).length === 2) controller.abort(new DOMException("audit stop", "AbortError"));
          } });
      } catch (error) {
        recovery = error instanceof UploadError ? error.recovery : client.pendingUploads[0];
      }
      if (!recovery) throw new Error("The upload finished before its second window could be stopped");
      await recovery.settled;
      const paidBeforeResume = counter.payments;
      const resumedEvents = [];
      const resumed = await client.resumeUpload(recovery, { payment: counter.provider,
        onProgress: (event) => resumedEvents.push(event.message) });
      const downloaded = await client.download(resumed.file);
      outcome.resumed = {
        paidBeforeResume, payments: counter.payments, records: resumed.records,
        windowsBeforeStop: windowsOf(events), windowsAfterResume: windowsOf(resumedEvents),
        reencrypted: resumedEvents.some((message) => /again to resume after record/u.test(message)),
        status: recovery.status,
        matches: await digest(downloaded.bytes) === await digest(await file.arrayBuffer()),
      };
      window.auditLog({ label: "resumed", ...outcome.resumed });

      // In-memory private bytes use one batch without the worker.
      const bytes = crypto.getRandomValues(new Uint8Array(65536));
      const inMemory = await client.upload(bytes, { visibility: "private", payment: counting().provider });
      const read = await client.download({ dataMap: inMemory.file.dataMap });
      outcome.inMemoryPrivate = { records: inMemory.records, matches: await digest(read.bytes) === await digest(bytes) };
      return outcome;
    } finally {
      client.close();
    }
  }, { sdk, endpoint, rpcUrl: info.evm.rpc_url, key, fileBytes: WINDOWED_FILE_BYTES, enforcedQuota: WINDOWED_QUOTA });

  // 3. Incognito contexts keep IndexedDB in memory and did not reuse deleted space
  // in probes, so the second window cannot be staged. Record that limitation.
  const incognitoPage = await quotaLimitedPage(await browser.newContext());
  results.incognito = await incognitoPage.evaluate(async ({ sdk, endpoint, rpcUrl, key, fileBytes }) => {
    const { AutonomiClient } = await import(`/@fs/${sdk}/dist/index.js`);
    const { createEthersPaymentProvider } = await import(`/@fs/${sdk}/dist/ethers.js`);
    const payment = createEthersPaymentProvider({ privateKey: key, rpcUrl });
    const bytes = new Uint8Array(fileBytes);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
    }
    const client = await AutonomiClient.connect(endpoint, { payment });
    const windows = [];
    try {
      await client.upload(new File([bytes], "incognito.bin"), { paymentMode: "single", onProgress: (event) => {
        if (/^Preparing storage for .* records \d+-\d+$/u.test(event.message)) windows.push(event.message);
      } });
      return { completed: true, windows };
    } catch (error) {
      const recovery = client.pendingUploads[0];
      await recovery?.discard();
      return { completed: false, windows, error: String(error?.message ?? error), retained: recovery !== undefined };
    } finally {
      client.close();
    }
  }, { sdk, endpoint, rpcUrl: info.evm.rpc_url, key, fileBytes: WINDOWED_FILE_BYTES });
  console.log(JSON.stringify({ label: "incognito", ...results.incognito }));

  const { windowed } = results;
  for (const label of ["public", "private", "merkle"]) {
    assert.equal(windowed[label].matches, true, label);
    assert.ok(windowed[label].windows.length > 1, `${label} upload used ${windowed[label].windows.length} window`);
  }
  assert.equal(windowed.public.payments, windowed.public.windows.length);
  assert.equal(windowed.private.address, null);
  assert.ok(windowed.private.dataMapBytes > 0);
  assert.equal(windowed.private.records, windowed.public.records - 1);
  assert.equal(windowed.merkle.paymentMode, "merkle");
  assert.ok(windowed.merkle.merklePayments >= 1);
  assert.equal(windowed.resumed.matches, true);
  assert.equal(windowed.resumed.status, "completed");
  assert.equal(windowed.resumed.reencrypted, true);
  assert.equal(windowed.resumed.payments,
    windowed.resumed.windowsBeforeStop.length - 1 + windowed.resumed.windowsAfterResume.length);
  assert.equal(windowed.inMemoryPrivate.matches, true);
  assert.equal(results.incognito.completed, false);
  assert.equal(results.incognito.retained, true);
  assert.equal(results.incognito.windows.length, 1);
  assert.match(results.incognito.error, /Not enough browser storage/u);
  results.servedWasmHashes = [...wasmHashes];
  assert.deepEqual(results.servedWasmHashes, [results.provenance.wasmSha256]);
  results.errors = errors;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results));
} catch (error) {
  results.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(`${root}/results.json`, JSON.stringify(results, null, 2));
  await profile?.close();
  await browser?.close();
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
  await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 15_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  })));
}
