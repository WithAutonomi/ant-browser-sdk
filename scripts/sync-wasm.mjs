import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/WithAutonomi/ant-client";

// ANT_CLIENT_DIR builds a local checkout as-is, for developing the Rust boundary.
// Otherwise a clean checkout of ANT_CLIENT_REF (default: main) is fetched from GitHub,
// which is what releases ship.
const localCheckout = process.env.ANT_CLIENT_DIR;
const ref = process.env.ANT_CLIENT_REF ?? "main";
if (localCheckout && process.env.ANT_CLIENT_REF) {
  throw new Error("Set either ANT_CLIENT_DIR or ANT_CLIENT_REF, not both.");
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `:\n${result.stderr.trim()}` : ""}`);
  }
  return result.stdout?.trim() ?? "";
};

const cleanCheckout = localCheckout ? undefined : await mkdtemp(join(tmpdir(), "ant-client-"));
try {
  const antClient = localCheckout ? resolve(root, localCheckout) : cleanCheckout;
  if (cleanCheckout) {
    console.log(`Fetching ${repository} ${ref}`);
    run("git", ["init", "--quiet", cleanCheckout]);
    run("git", ["fetch", "--quiet", "--depth", "1", "--no-tags", `${repository}.git`, ref], { cwd: cleanCheckout });
    run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: cleanCheckout });
  }

  const crate = resolve(antClient, "ant-core");
  try {
    await access(resolve(crate, "Cargo.toml"));
  } catch {
    throw new Error(`Could not find ant-core at ${crate}. Set ANT_CLIENT_DIR to an ant-client checkout.`);
  }

  // A clean checkout must build exactly its committed lockfile. Its build products are
  // kept outside the temporary checkout so later syncs reuse compiled dependencies.
  run(
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
      ...(cleanCheckout ? ["--locked"] : []),
    ],
    {
      stdio: "inherit",
      env: cleanCheckout
        ? { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? resolve(root, ".cache/ant-core-wasm") }
        : process.env,
    },
  );

  const revision = run("git", ["rev-parse", "HEAD"], { cwd: antClient });
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: antClient });
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(resolve(root, "src/wasm/source.json"), `${JSON.stringify({
    repository,
    revision,
    dirty: status.length > 0,
    target: "wasm32-unknown-unknown",
    features: ["browser-wasm"],
    defaultFeatures: false,
    cargoLockSha256: sha256(await readFile(resolve(antClient, "Cargo.lock"))),
    wasmSha256: sha256(await readFile(resolve(root, "src/wasm/ant_core_bg.wasm"))),
  }, null, 2)}\n`);
  console.log(`Synced WASM from ant-client ${revision}${localCheckout ? ` (${antClient})` : ` (${ref})`}`);
} finally {
  if (cleanCheckout) await rm(cleanCheckout, { recursive: true, force: true });
}
