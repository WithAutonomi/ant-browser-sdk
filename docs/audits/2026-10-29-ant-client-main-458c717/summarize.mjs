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
// Paired by round: the candidate (second variant) against the baseline (first).
const [baseline, candidate] = report.variants.map(variant => variant.name);
for (const [metric, label] of [["firstFrameMs", "first frame"], ["seekMs", "seek"]]) {
  const pairs = [];
  for (let round = 1; round <= report.rounds; round++) {
    const x = report.samples.find(sample => sample.round === round && sample.variant === candidate && sample.status === "passed");
    const y = report.samples.find(sample => sample.round === round && sample.variant === baseline && sample.status === "passed");
    if (x && y) pairs.push(y[metric] - x[metric]);
  }
  console.log(`${label}: ${candidate} sooner than ${baseline} in ${pairs.filter(d => d > 0).length} of ${pairs.length} rounds; median paired difference ${seconds(quantile(pairs, 0.5))} s (positive: ${candidate} sooner)`);
}
for (const variant of [baseline, candidate]) {
  const mine = report.samples.filter(sample => sample.variant === variant).sort((a, b) => a.round - b.round);
  console.log(`${variant} per round: first frame ${mine.map(x => x.status === "passed" ? seconds(x.firstFrameMs) : "x").join(", ")}; seek ${mine.map(x => x.status === "passed" ? seconds(x.seekMs) : "x").join(", ")}`);
}
for (const sample of report.samples.filter(sample => sample.status !== "passed")) console.log("failed:", sample.round, sample.variant, sample.error ?? `played ${sample.playedIn10s}`);
console.log("WASM:", [...new Set(report.samples.flatMap(sample => sample.wasm))].join(", "), "| page errors:", report.samples.reduce((n, sample) => n + sample.pageErrors.length, 0));
