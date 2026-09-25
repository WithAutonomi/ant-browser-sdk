# Read startup validation — 2026-09-25

The generated production WASM was refreshed after profiling public-file startup
through File Vault and correcting the shared Rust read scheduler and WebRTC
connection pool. Public SDK APIs, file formats and payment behavior are unchanged.

The detailed investigation, reproducible Chromium probe, bootstrap list, raw
per-peer traces and test logs are in the sibling client checkout:
[`docs/investigations/2026-09-25-read-startup/README.md`](../../../ant-client-web-support/docs/investigations/2026-09-25-read-startup/README.md).
The shared network-policy decision is recorded in its Proposed ADR-0004.

## Exact sources and artifact

- SDK base: `2f7ea572346b7489c096d390fefa1920e8d6c69b`, with generated artifact
  changes and this audit in the working tree.
- Core base: `a93360f3785bfd9eb7afd672f8c5395e2a4b25b4`, with the accompanying
  read-startup changes. The investigation records hashes of changed source files.
- Local node revision: `b0263b324c418a5732d1727d7a66df4c15946559`.
- WASM SHA-256:
  `c08af347ad7231e2933cacb73418191c6434090000d1a70f7d6e649b7e494574`.
- Cargo.lock SHA-256:
  `99468f9bc974ce2187e94e0559f9ce1f089c0f897ff1ef8087db6a303421859a`.
- Features: `browser-wasm`, no default features, `wasm32-unknown-unknown`.
  `test-utils` diagnostics are excluded from the production bindings.

Rebuilt using `ANT_CLIENT_DIR=../ant-client-web-support npm run sync:wasm`.
Generated bindings, binary and `src/wasm/source.json` were regenerated together.
Provenance truthfully records `dirty: true`; this is a local development artifact,
not a release from a clean source tree. Existing unrelated SDK work was preserved.

## Results

The test address was
`134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889`.
For fresh clients using File Vault's first seed, four baseline samples versus
three final changed-core samples had median first-chunk times of 51.5 versus
43.3 seconds and median third-chunk times of 70.6 versus 49.5 seconds. These are
small public-network samples with substantial variation, not latency guarantees.

The production SDK path imported File Vault's linked SDK from its running Vite
server, called `AutonomiClient.connect()` then `downloadAndSave()`, and stopped
after three chunks. Baseline: first 50.632 s, third 60.153 s. Refreshed artifact:
first 45.027 s, third 52.719 s. File Vault was rebuilt and its bundled WASM hash
matches the SDK. This probe exercised the SDK path, not File Vault UI automation.

## Commands and checks

- `npm run check`: build, types and all 185 tests passed.
- `npm run build:examples`: all five examples built.
- `npm pack --dry-run`: passed; no package published.
- `python3 scripts/adr-governance.py`: passed.
- `python3 .github/scripts/test_check_pr.py`: 52/52 passed.
- Core shared engine: 128 tests; generated WASM: 163 tests; native and WASM
  Clippy with warnings denied: passed.
- Core `ant-core/browser-tests/npm test`: real Chromium against seven isolated
  browser-enabled nodes and Anvil, paid-upload recovery followed by a matching
  public download: passed.
- Actual SDK all-in-one demo: started those local nodes with
  `node start-devnet.mjs` from the core browser-tests directory, served this SDK
  with `node node_modules/vite/bin/vite.js --config examples/all-in-one/vite.config.ts --port 35174 --strictPort`,
  and drove the demo in Chromium. Authenticated, paid for four records using only
  the guarded local Anvil account, uploaded, downloaded and saved 13,056 matching
  bytes. No page errors. Task-owned nodes and demo server were shut down.
- File Vault `npm test`: 44 passed; `npm run build`: passed.

The test-only trace API is absent from the refreshed production JS/types. The
large public-file probes stop after three content chunks; full-file correctness
is separately covered by the regressions and real local-browser downloads. The
historical 38-second reconstruction/hash tail was not optimized in this change.
