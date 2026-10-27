// Per-arm medians and round-paired differences for ab.mjs results.
// Usage: node summarize.mjs RESULTS.jsonl BASELINE_ARM [EXPECTED_SHA256]
import { readFileSync } from "node:fs";

const [file, baseline, expectedSha] = process.argv.slice(2);
const samples = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const quantile = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
};
const s = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "-");
const mode = samples[0]?.mode;
const metrics = mode === "download"
  ? { "download (s)": x => x.ms, "connect (s)": x => x.connectMs, "connections": x => x.connections * 1000, "MB received": x => x.rx / 1e3 }
  : { "first frame (s)": x => x.firstFrameMs, "seek to 85% (s)": x => x.seekMs, "connect (s)": x => x.connectMs, "connections": x => x.connections * 1000 };
const arms = [...new Set(samples.map(x => x.arm))];
const table = {};
for (const arm of arms) {
  const mine = samples.filter(x => x.arm === arm);
  const ok = mine.filter(x => x.ok);
  const row = { samples: mine.length, failed: mine.length - ok.length };
  for (const [name, get] of Object.entries(metrics)) {
    const values = ok.map(get);
    row[name] = `${s(quantile(values, 0.5))} (${s(quantile(values, 0.25))}–${s(quantile(values, 0.75))})`;
  }
  if (expectedSha) row["SHA-256 ok"] = `${ok.filter(x => x.sha256 === expectedSha).length}/${ok.length}`;
  table[arm] = row;
}
console.log(`${mode}, ${samples[0]?.engine}: median (middle half)`);
console.table(table);
const key = mode === "download" ? "ms" : "firstFrameMs";
for (const arm of arms.filter(arm => arm !== baseline)) {
  const differences = [];
  for (const round of [...new Set(samples.map(x => x.round))]) {
    const a = samples.find(x => x.round === round && x.arm === baseline && x.ok);
    const b = samples.find(x => x.round === round && x.arm === arm && x.ok);
    if (a && b) differences.push(a[key] - b[key]);
  }
  console.log(`${arm} faster than ${baseline} in ${differences.filter(d => d > 0).length} of ${differences.length} rounds; median paired saving ${s(quantile(differences, 0.5))} s, ${Math.round(100 * quantile(differences, 0.5) / quantile(samples.filter(x => x.arm === baseline && x.ok).map(x => x[key]), 0.5))}% of ${baseline}'s median`);
}
for (const x of samples.filter(x => !x.ok)) console.log(`failed: round ${x.round} ${x.arm}: ${x.error ?? `played ${x.playedIn10s}`}`);
const errors = samples.reduce((n, x) => n + (x.pageErrors?.length ?? 0), 0);
console.log(`WASM by arm: ${arms.map(arm => `${arm}=${[...new Set(samples.filter(x => x.arm === arm).flatMap(x => x.wasm))].join(",")}`).join(" ")}; page errors: ${errors}`);
