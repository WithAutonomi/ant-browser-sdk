import { access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const antClient = resolve(
  root,
  process.env.ANT_CLIENT_DIR ?? "../ant-client-web-support",
);
const crate = resolve(antClient, "ant-core");
try {
  await access(resolve(crate, "Cargo.toml"));
} catch {
  throw new Error(
    `Could not find ant-core at ${crate}. Set ANT_CLIENT_DIR to an ant-client checkout.`,
  );
}

const build = spawnSync(
  "wasm-pack",
  [
    "build",
    "--target",
    "web",
    "--out-dir",
    resolve(root, "src/wasm"),
    "--release",
    crate,
    "--no-default-features",
    "--features",
    "browser-wasm",
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: antClient, encoding: "utf8" });
const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: antClient, encoding: "utf8" });
if (revision.status !== 0 || status.status !== 0) throw new Error("Could not record ant-core source revision");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await writeFile(resolve(root, "src/wasm/source.json"), `${JSON.stringify({
  repository: "https://github.com/WithAutonomi/ant-client",
  revision: revision.stdout.trim(),
  dirty: status.stdout.trim().length > 0,
  target: "wasm32-unknown-unknown",
  features: ["browser-wasm"],
  defaultFeatures: false,
  cargoLockSha256: sha256(await readFile(resolve(antClient, "Cargo.lock"))),
  wasmSha256: sha256(await readFile(resolve(root, "src/wasm/ant_core_bg.wasm"))),
}, null, 2)}\n`);
