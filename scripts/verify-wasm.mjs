import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Release gate: the bundled WASM must be a clean build of a commit on ant-client main.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/WithAutonomi/ant-client";
const releaseBranch = "main";

const source = JSON.parse(await readFile(resolve(root, "src/wasm/source.json"), "utf8"));
const wasm = await readFile(resolve(root, "src/wasm/ant_core_bg.wasm"));
const failures = [];

if (createHash("sha256").update(wasm).digest("hex") !== source.wasmSha256) {
  failures.push("src/wasm/ant_core_bg.wasm does not match wasmSha256 in src/wasm/source.json.");
}
// The licence notices ship with the WASM and must come from the same sync, made with
// the generator and config committed now.
for (const [file, key] of [
  ["src/wasm/THIRD-PARTY-NOTICES.txt", "noticesSha256"],
  ["src/wasm/RUST-STD-COPYRIGHT.html", "rustStdCopyrightSha256"],
  ["scripts/third_party_notices/generate.py", "noticesGeneratorSha256"],
  ["scripts/third_party_notices/config.toml", "noticesConfigSha256"],
]) {
  let bytes;
  try {
    bytes = await readFile(resolve(root, file));
  } catch {
    failures.push(`${file} is missing.`);
    continue;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source[key]) {
    failures.push(`${file} does not match ${key} in src/wasm/source.json.`);
  }
}
if (source.repository !== repository) {
  failures.push(`The WASM was built from ${source.repository}, not ${repository}.`);
}
if (source.dirty !== false) {
  failures.push("The WASM was built from a checkout with uncommitted changes.");
}

// compare/<revision>...main reports "ahead" or "identical" only when the revision is on main.
const response = await fetch(`https://api.github.com/repos/WithAutonomi/ant-client/compare/${source.revision}...${releaseBranch}`, {
  headers: {
    accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
});
if (response.status === 404) {
  failures.push(`ant-client has no commit ${source.revision}.`);
} else if (!response.ok) {
  throw new Error(`GitHub compare failed with HTTP ${response.status}: ${await response.text()}`);
} else {
  const { status } = await response.json();
  if (status !== "ahead" && status !== "identical") {
    failures.push(`ant-client ${source.revision} is not on ${releaseBranch} (compare status: ${status}).`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`);
  console.error("Rebuild the WASM from ant-client main with `npm run sync:wasm` and commit src/wasm together.");
  process.exit(1);
}
console.log(`WASM provenance and licence notices verified: ant-client ${source.revision} on ${releaseBranch}, sha256 ${source.wasmSha256}.`);
