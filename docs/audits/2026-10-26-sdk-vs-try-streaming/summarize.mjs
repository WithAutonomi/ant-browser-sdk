// Summarise compare.mjs results. Usage: node summarize.mjs results.json
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const seconds = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "-");
const quantile = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
};
const names = report.variants.map(variant => variant.name);
const rows = {};
for (const name of names) {
  const mine = report.samples.filter(sample => sample.variant === name);
  const passed = mine.filter(sample => sample.status === "passed");
  const first = passed.map(sample => sample.firstFrameMs), seek = passed.map(sample => sample.seekMs);
  rows[name] = {
    samples: mine.length,
    failed: mine.length - passed.length,
    "first frame median (s)": seconds(quantile(first, 0.5)),
    "first frame middle half (s)": `${seconds(quantile(first, 0.25))}–${seconds(quantile(first, 0.75))}`,
    "first frame range (s)": `${seconds(Math.min(...first))}–${seconds(Math.max(...first))}`,
    "seek median (s)": seconds(quantile(seek, 0.5)),
    "seek middle half (s)": `${seconds(quantile(seek, 0.25))}–${seconds(quantile(seek, 0.75))}`,
    "waiting events, median": quantile(passed.map(sample => sample.waiting), 0.5),
  };
}
console.table(rows);
for (const [a, b] of [["sdk-now", "try"], ["sdk-now", "sdk-before"]]) {
  const pairs = [];
  for (let round = 1; round <= report.rounds; round++) {
    const x = report.samples.find(sample => sample.round === round && sample.variant === a && sample.status === "passed");
    const y = report.samples.find(sample => sample.round === round && sample.variant === b && sample.status === "passed");
    if (x && y) pairs.push(y.firstFrameMs - x.firstFrameMs);
  }
  console.log(`${a} first frame sooner than ${b} in ${pairs.filter(d => d > 0).length} of ${pairs.length} rounds; median paired difference ${seconds(quantile(pairs, 0.5))} s (positive: ${a} sooner)`);
}
for (const sample of report.samples.filter(sample => sample.status !== "passed")) console.log("failed:", sample.round, sample.variant, sample.error ?? `played ${sample.playedIn10s}`);
console.log("WASM:", [...new Set(report.samples.flatMap(sample => sample.wasm))].join(", "), "| page errors:", report.samples.reduce((n, sample) => n + sample.pageErrors.length, 0));
