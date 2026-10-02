import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

// Everything a sync produces is assembled in a staging directory and swapped in for
// src/wasm only once complete, so a failure part-way never leaves a mixed set. The
// set being replaced is kept in `previous` until the new one is in place.
const wasmDir = resolve(root, "src/wasm");
const previous = resolve(root, ".cache/wasm-previous");
const exists = (path) => stat(path).then(() => true, () => false);
if (await exists(previous)) {
  if (await exists(wasmDir)) {
    // Either a finished sync could not tidy up, or a failed one left its only
    // backup here; only a person can tell which.
    throw new Error(`${previous} is left over from an earlier sync. Check src/wasm, then delete ${previous} and run again.`);
  }
  // An earlier sync stopped between its two renames: put the old set back.
  await rename(previous, wasmDir);
}
const cleanCheckout = localCheckout ? undefined : await mkdtemp(join(tmpdir(), "ant-client-"));
let notices;
let staging;
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

  // The licence notices for exactly what this build bundles: every crate's licence,
  // copyright and notice files (scripts/third_party_notices, Python 3.11+), and the
  // Rust standard library's notices from the toolchain Cargo uses for this crate.
  // They are produced first, from the lockfile, so a problem there fails early.
  const python = process.env.PYTHON ?? "python3";
  if (spawnSync(python, ["-c", "import sys; sys.exit(sys.version_info < (3, 11))"]).status !== 0) {
    throw new Error(`${python} is not Python 3.11 or newer; set PYTHON to one that is.`);
  }
  const generator = resolve(root, "scripts/third_party_notices/generate.py");
  const config = resolve(root, "scripts/third_party_notices/config.toml");
  notices = await mkdtemp(join(tmpdir(), "ant-sdk-notices-"));
  run(
    python,
    [
      generator,
      "--manifest-path",
      resolve(antClient, "Cargo.toml"),
      "--package",
      "ant-core",
      "--no-default-features",
      "--features",
      "browser-wasm",
      "--target",
      "wasm32-unknown-unknown",
      "--config",
      config,
      "--output",
      join(notices, "THIRD-PARTY-NOTICES.txt"),
    ],
    { stdio: "inherit" },
  );
  const rustcCommand = process.env.RUSTC ?? "rustc";
  const rustc = run(rustcCommand, ["-V"], { cwd: crate });
  const sysroot = run(rustcCommand, ["--print", "sysroot"], { cwd: crate });
  await copyFile(
    join(sysroot, "share", "doc", "rust", "COPYRIGHT-library.html"),
    join(notices, "RUST-STD-COPYRIGHT.html"),
  );
  const wasmPack = run("wasm-pack", ["--version"]);

  // A clean checkout must build exactly its committed lockfile. Its build products are
  // kept outside the temporary checkout so later syncs reuse compiled dependencies.
  await mkdir(resolve(root, ".cache"), { recursive: true });
  staging = await mkdtemp(resolve(root, ".cache/wasm-staging-"));
  run(
    "wasm-pack",
    [
      "build",
      "--target",
      "web",
      "--out-dir",
      staging,
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

  for (const file of ["THIRD-PARTY-NOTICES.txt", "RUST-STD-COPYRIGHT.html"]) {
    await copyFile(join(notices, file), join(staging, file));
  }

  const revision = run("git", ["rev-parse", "HEAD"], { cwd: antClient });
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: antClient });
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(staging, "source.json"), `${JSON.stringify({
    repository,
    revision,
    dirty: status.length > 0,
    target: "wasm32-unknown-unknown",
    features: ["browser-wasm"],
    defaultFeatures: false,
    cargoLockSha256: sha256(await readFile(resolve(antClient, "Cargo.lock"))),
    wasmSha256: sha256(await readFile(join(staging, "ant_core_bg.wasm"))),
    rustc,
    wasmPack,
    noticesSha256: sha256(await readFile(join(staging, "THIRD-PARTY-NOTICES.txt"))),
    rustStdCopyrightSha256: sha256(await readFile(join(staging, "RUST-STD-COPYRIGHT.html"))),
    noticesGeneratorSha256: sha256(await readFile(generator)),
    noticesConfigSha256: sha256(await readFile(config)),
  }, null, 2)}\n`);

  await rename(wasmDir, previous);
  try {
    await rename(staging, wasmDir);
  } catch (error) {
    try {
      await rename(previous, wasmDir);
    } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not install the new WASM or restore the old one; the old set is in ${previous}.`);
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true }).catch(() => {
    console.warn(`Synced, but could not remove ${previous}; delete it before the next sync.`);
  });
  console.log(`Synced WASM from ant-client ${revision}${localCheckout ? ` (${antClient})` : ` (${ref})`}`);
} finally {
  // Best effort, and never in place of the error that ended the sync.
  for (const path of [cleanCheckout, notices, staging]) {
    if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
