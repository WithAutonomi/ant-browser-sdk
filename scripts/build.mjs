import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
const typeScript = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "--project", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
if (typeScript.status !== 0) process.exit(typeScript.status ?? 1);

await mkdir(resolve(dist, "wasm"), { recursive: true });
for (const file of [
  "ant_core.js",
  "ant_core.d.ts",
  "ant_core_bg.wasm",
  "ant_core_bg.wasm.d.ts",
]) {
  await cp(resolve(root, "src/wasm", file), resolve(dist, "wasm", file));
}
await cp(resolve(root, "src/upload-worker.js"), resolve(dist, "upload-worker.js"));
await cp(
  resolve(root, "public/autonomi-stream-sw.js"),
  resolve(dist, "autonomi-stream-sw.js"),
);
