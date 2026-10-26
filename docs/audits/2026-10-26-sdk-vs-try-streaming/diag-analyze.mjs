// Break each traced sample of diag.mjs into the first record's fetch and what
// ran beside it. Usage: node diag-analyze.mjs diag.json [first-record-prefix]
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const FIRST = process.argv[3] ?? "09313e9d";
const median = values => { const s = values.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? Math.round(s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : "-"; };
const rows = [];
for (const sample of report.samples.filter(s => s.status === "passed")) {
  const byId = new Map();
  for (const event of sample.trace ?? []) {
    if (!byId.has(event.id)) byId.set(event.id, { op: event.op, target: event.target, peer: event.peer, phases: {} });
    byId.get(event.id).phases[event.phase] ??= { at: event.at, detail: event.detail };
  }
  const ops = [...byId.values()];
  const firstGets = ops.filter(op => op.op === "rpc" && op.target === FIRST && op.phases.start);
  const holder = firstGets.filter(op => /^found/.test(op.phases.finish?.detail ?? "")).sort((a, b) => a.phases.finish.at - b.phases.finish.at)[0];
  const head = (sample.reads ?? []).find(read => read.start === 0);
  const playerRange = (sample.ranges ?? []).find(range => range.range === "bytes=0-");
  const before = op => op.phases.start.at < (holder?.phases.finish.at ?? Infinity);
  rows.push({
    variant: sample.variant,
    round: sample.round,
    firstFrame: Math.round(sample.firstFrameMs),
    headRead: head ? head.end - head.at : "-",
    playerAsked: playerRange?.at ?? "-",
    lookupsFirst: ops.filter(op => op.op === "discovery" && op.target === FIRST).length,
    getsFirst: firstGets.filter(before).length,
    holderStart: holder?.phases.start.at ?? "-",
    holderDone: holder?.phases.finish.at ?? "-",
    otherLookups: ops.filter(op => op.op === "discovery" && op.target !== FIRST && op.phases.start.at < (holder?.phases.finish.at ?? Infinity)).length,
    otherGets: ops.filter(op => op.op === "rpc" && op.target !== FIRST && op.phases.start && before(op)).length,
  });
}
console.table(rows);
const summary = {};
for (const variant of [...new Set(rows.map(row => row.variant))]) {
  const mine = rows.filter(row => row.variant === variant);
  summary[variant] = Object.fromEntries(["firstFrame", "headRead", "playerAsked", "lookupsFirst", "getsFirst", "holderStart", "holderDone", "otherLookups", "otherGets"].map(key => [key, median(mine.map(row => row[key]))]));
}
console.table(summary);
