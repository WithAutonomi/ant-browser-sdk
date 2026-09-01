import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const antClient = resolve(
  root,
  process.env.ANT_CLIENT_DIR ?? "../ant-client",
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
