// The SDK against the live network: connect on load, then on request either
// download a public file with download(), or stream a manifest entry with
// createMediaSource() and time its first frame, playback and a seek.
// window.__harness drives it from Playwright.
import { AutonomiClient, PublicFileReader, decodeManifest } from "./sdk/index.js";

// Every read the reader serves, for the timeline.
const reads = [];
const read = PublicFileReader.prototype.read;
PublicFileReader.prototype.read = async function (start, length, ...rest) {
  const entry = { start, length, at: performance.now() };
  reads.push(entry);
  try { return await read.call(this, start, length, ...rest); } finally { entry.ms = performance.now() - entry.at; }
};

const harness = window.__harness = { state: "connecting", error: null };
const video = document.getElementById("player");
let client;
try {
  const connectStarted = performance.now();
  client = await AutonomiClient.connect();
  harness.connectMs = performance.now() - connectStarted;
  harness.state = "connected";
} catch (error) {
  harness.state = "failed";
  harness.error = String(error?.message ?? error);
}

harness.run = async ({ manifestUrl }) => {
  const entry = (await decodeManifest(new Uint8Array(await (await fetch(manifestUrl)).arrayBuffer()))).entries[0];
  const result = { waiting: 0 };
  reads.length = 0;
  video.addEventListener("waiting", () => result.waiting++);
  const started = performance.now();
  const source = await client.createMediaSource(entry);
  result.sourceReadyMs = performance.now() - started;
  const first = new Promise(resolve => video.requestVideoFrameCallback(at => resolve(at - started)));
  video.src = source.url;
  await video.play();
  result.firstFrameMs = await first;
  result.readsBeforeFirstFrame = reads.map(entry => ({ start: entry.start, length: entry.length, at: Math.round(entry.at - started), ms: Math.round(entry.ms ?? -1) }));
  const playbackStart = video.currentTime;
  await new Promise(resolve => setTimeout(resolve, 10_000));
  result.playedIn10s = video.currentTime - playbackStart;
  // Beyond the 32 MiB read-ahead window from the start, and before the last
  // record, which streaming mode fetches with the first.
  const target = video.duration * 0.85;
  const seekStarted = performance.now();
  const seek = new Promise(resolve => {
    const onFrame = (at, metadata) => (Math.abs(metadata.mediaTime - target) < 1 ? resolve(at - seekStarted) : video.requestVideoFrameCallback(onFrame));
    video.requestVideoFrameCallback(onFrame);
  });
  video.currentTime = target;
  await video.play();
  result.seekMs = await Promise.race([seek, new Promise((_, reject) => setTimeout(() => reject(new Error("seek frame deadline")), 60_000))]);
  video.pause();
  video.removeAttribute("src");
  video.load();
  source.close();
  return result;
};

harness.download = async ({ address }) => {
  const started = performance.now();
  const result = await client.download(address);
  const ms = performance.now() - started;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", result.bytes));
  return { ms, bytes: result.bytes.byteLength, sha256: Array.from(digest, b => b.toString(16).padStart(2, "0")).join("") };
};
