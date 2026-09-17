# Adaptive download validation — 2026-09-17

Implements [Proposed ADR-0003](../adr/ADR-0003-adaptive-browser-downloads.md).
This report supplements the earlier historical performance investigation; it does
not change its results.

## Revisions and environment

- Rust client: `06fdc8856a3961dc9cbdaf0e8cb6f4293613a21e`, clean tracked sources.
- Rust feature commits: `0ae3967` (progressive verified reads), `f57af6c`
  (independent control/data channels), `34a8d82` (adaptive fetch admission),
  `06fdc88` (sustained-load back-pressure correction).
- SDK tested: `2234fc65c718fcbf9f7b174bbcbc16486c86cb9f`.
- Native live binary: `34a8d82f873303fbf6efad596f9c6aa156b9d241`; the subsequent
  `06fdc88` changes affect browser code and its tests, not native production code.
- Production WASM SHA-256: `18159a8934dc6b697708901f7299bfbc1a0c368c180fe1b198f90de6dc072581`.
- Cargo.lock SHA-256: `1ab74a6bdbeaa1fc48e90f7fa9ea7f88235e6eb8ddf3025eccc8fb18364e629e`. Dependencies are pinned
  in Cargo.toml/Cargo.lock; no sibling transport/node crates were changed.
- Previous WASM SHA-256: `adb708950d89c8a876d2bf9d4d0049f1fe2c890e8fcb500c57aec3262f401b96`. This is the preserved
  artifact measured before these changes, built from `7e3e891` plus patch
  `3211777b50a8020923119f569361451b321ecfd35da533ae29b130ccd8a09e32`. Its provenance correctly says `dirty: true`.
  Reconstructing that patch and comparing it with `4afa5dd` found identical
  code except a formatting-only call layout in wasm_transport.rs.
- Previous native binary SHA-256: `01c06eea4615263a99df30ca655d9797cd6e2fb3739738b689d26507596e3b79`;
  final native binary SHA-256: `4d53473e1bb42ec25cbec9a08fdfb84f27fef177bb321e90c61e36f553c15974`.
- Deployed web-support testnet node: `26f5fb79fbd82ff7dbe016ea46cd1afffaf5c442`;
  existing 60-node deployment, including 18 symmetric-NAT nodes. No redeployment.
- macOS 26.5.2, Apple M3 Ultra, 512 GiB RAM; Chromium 151.0.7922.34, headless.
  No product defaults are selected from this machine's processor or RAM count.

## Workload and timing

Public address:
`7a95f1fb5884648f3d29d32c19f93aeb434b25d5bc5a33900821d5fc646bdd73`.
Every completed trial returned 88,687,079 bytes (84.58 MiB), 22 data chunks, and
independently checked SHA-256
`9ee6646117e9f054458d18e1022b47dea1f59581d6ee00faaafdcec448284abd`.
The core also verified records and the final BLAKE3
`ba41cdb9bf489442539e6ba1e26c48d3c9816a63712a183c56df4f9682694881`.

Benchmark clients used the same three geographic bootstrap hosts and deployed file.
Browser clients used pinned WebRTC addresses; native used the QUIC endpoints in
`../ant-testnet/state/testnets/web-support/client-manifest.json`. Each trial used
a fresh process/client. Native adaptive and peer-cache files were backed up,
removed for each native trial, then restored byte-for-byte in a finally block.
Native therefore started at fetch concurrency four each time, matching browser.
All final native runs ended at five, showing learning during this file.

The first matrix ran serially, with the second round's order reversed. After
the CPU correction, the affected WASM variants were repeated, plus three CPU
trials per variant and a final baseline recheck. Native code was unchanged by
the correction, so its six successful original trials are retained; one more
native pair was checked after the browser runs. No builds
or test suites competed with timed runs. These are live testnet measurements
across a session, not controlled simultaneous network conditions.
Native timings include process startup,
bootstrap, verification, reconstruction, and file output. WASM timings include
bootstrap, verification, reconstruction, and returned bytes; browser launch,
module loading and the independent SHA-256 check are excluded. This preserves
the earlier harness boundary; output handling differs between the tiers.
No trusted data proxy, predownloaded file cache, skipped hash verification, or
weakened discovery/quorum rule was introduced.

## Repeated live results

| Client | Fresh trials (seconds) | Median (seconds) |
| --- | --- | --- |
| Previous WASM, cap 3 | 62.067 / 65.198 / 60.175 / 69.741 | 63.633 |
| New WASM, cap 3 | 57.890 / 52.646 / 56.219 | 56.219 |
| New WASM, auto | 42.510 / 49.971 / 59.570 | 49.971 |
| Previous native | 19.954 / 19.200 / 19.331 / 18.990 | 19.265 |
| New native | 13.436 / 14.599 / 13.207 / 13.188 | 13.322 |

Compared with the previous default, adaptive WASM reduced median elapsed time
by 21.5% (1.27× speedup).
The WASM/native median ratio changed from
3.30× to 3.75×. **These final samples do not show a
smaller relative WASM/native gap**, despite the absolute WASM improvement.
Native also improved because progressive read policy and fetch observation
changes are shared. The cap-three control shows the effect of the full changes
while retaining the old application ceiling; it is not an isolated transport
ablation.

Single-change pilots: progressive reads with cap three took 42.118 s; adding
separate channels took 45.332 s. Those single samples do **not** demonstrate an
incremental download gain from separate channels. The deterministic regression
suite demonstrates that a delayed GET no longer blocks FIND_NODE (and vice
versa), with one ICE association and independent authenticated sessions.

Median received browser DataChannel bytes (including protocol and speculative
work): previous 102.65 MiB,
new auto 113.81 MiB.
This is application-channel traffic, not total UDP/DTLS wire accounting.

## Slower CPU and real SDK demo

With Chromium CDP CPU throttling set to 4×, the previous cap-three client had a
median of 76.055 s and new auto had a median of 47.595 s. Both matched the expected
bytes/hash. Three fresh samples per variant were:
previous 62.291 / 76.303 / 76.055 s;
new 49.865 / 39.771 / 47.595 s.
This is a CPU-throttling scenario, not a measurement on a physical low-end device.
No CDP network-throttle claim is made
for WebRTC.

The initial per-response back-pressure rule regressed the first CPU trial from
62.291 s to 66.447 s. Its transport trace showed nearly serialized GETs after
individual slow responses reduced admission. Commit `06fdc88` replaces that rule
with eight-response windows requiring sustained GET CPU occupancy above half
the window and at least two stalls above 50 ms. Isolated expensive responses or
background timer clamping no longer cause serial network waits. Both the
initial result and trace remain in `first-adaptive/`; the table above uses the
corrected artifact. Native scheduler logic was unchanged by this correction.

The built all-in-one SDK example was also exercised through its actual Connect
and Download-and-save buttons against the Amsterdam seed. Omitted concurrency
used auto. The saved file matched the same independent digest and byte count,
with no page errors. Download/save took 51.910 s (separate smoke
run, not included in the paired table). Headless Chromium used the SDK's
supported anchor fallback with the OS file picker disabled. No wallet or EVM
RPC was required.

## Commands and automated checks

From the Rust checkout:

```sh
cargo test -p ant-core --lib
cargo clippy -p ant-core --all-targets -- -D warnings
cargo clippy -p ant-core --target wasm32-unknown-unknown --no-default-features --features browser-wasm -- -D warnings -A dead_code
cargo build --release -p ant-cli
cd ant-core
wasm-pack build --target web --out-dir wasm-tests/pkg --release . --no-default-features --features browser-wasm,test-utils
node --import ./wasm-tests/setup-wasm.mjs --test ./wasm-tests/*.test.mjs
```

713 native tests and 144 generated-WASM tests passed. Clippy passed; the WASM
command allows the pre-existing unused `plan_merkle_upload` method warning.
New coverage includes progressive hints, absence decisions, fatal corruption,
peer deduplication, independent/cancelled channels, pool eviction/closure,
physical read bounds, admission cancellation, processing-pressure recovery,
shorter observation epochs, and rejection of stale-epoch observations.

From this SDK checkout, sequentially:

```sh
ANT_CLIENT_DIR=/Users/mick/RustroverProjects/ant-client-web-support npm run sync:wasm
npm run check
npm run build:examples
npm pack --dry-run
python3 scripts/adr-governance.py
python3 .github/scripts/test_check_pr.py
```

All passed: 158 SDK tests, TypeScript/build checks, five example builds, package
asset checks, three Proposed ADRs, and 52 PR-checker cases. The sync recorded a
clean source revision and generated bindings, binary, and provenance together.

Live harness commands (harnesses and full logs retained locally):

```sh
python3 /tmp/wasm-adaptive-20260917/matrix.py
python3 /tmp/wasm-adaptive-20260917/load-aware-matrix.py
node /tmp/wasm-adaptive-20260917/demo-run.mjs
python3 /tmp/wasm-adaptive-20260917/native-followup.py
```

The matrix invokes `browser-run.mjs` with `BENCH_WASM_DIR`, concurrency `3` or
`auto`, and `BENCH_CPU_RATE=4` for the CPU scenario. It invokes `native-run.py`
with `BENCH_NATIVE_BIN` and the explicit testnet manifest. Source JSON, individual
results, passive transport traces, diagnostics, build/test logs, and
`summary.json` are retained under `/tmp/wasm-adaptive-20260917/`. The test address
and machine-specific paths exist only in validation harnesses, not product code.

## Side effects and remaining limits

- Early reads may send speculative requests. Physical browser GET admission
  counts both early and ordinary requests; misses do not establish absence,
  and integrity failures remain fatal.
- The two-channel pool can retain a second authenticated session per peer;
  cancellation closes only the affected channel. Nodes configured below the
  current default of two allowed channels are incompatible; there is no
  single-channel fallback. The pool still bounds peer associations to 64.
  Code inspection also found a remote retirement race: the server counts channel
  handler tasks, while the client waits for the old DataChannel to reach closed.
  If a cancelled channel's server handler is still processing, its replacement
  can hit the two-task limit and the node can close the association, requiring
  reconnection. Local lane-isolation tests do not establish immunity to this
  server-side race; it was not separately fault-injected on the live deployment.
- The 128 MiB reservation ceiling bounds transient GET response reservations,
  not all browser memory. It permits at most eight worst-case responses in
  flight; actual admission also follows throughput and local processing.
  Whole-file buffers, caching, and SDK bytes/Blob copies still scale with file
  size. A worker/streaming reconstruction change is outside this work.
- Shorter observation epochs can make the shared scheduler probe sooner. They
  still require at least eight completions/two full waves; previous-cap work
  cannot train the new probe. Sustained CPU occupation and repeated responsiveness
  stalls must both be present before local admission decreases. A slow peer or
  one long response does not by itself lower that allowance; this does not
  shorten an individual long crypto task. The measured busy time covers transport
  decryption and response decoding, not all later record hashing or whole-file
  reconstruction work.
- Omitted SDK concurrency now means auto. Existing numeric 1–6 settings remain
  valid ceilings, but consumers of `SDK_LIMITS.downloadConcurrency.default`
  must handle its new string type. Explicit ceilings may still be limited by
  the browser response budget.
- Live evidence covers this file, deployment, Chromium, and host. It does not
  establish optimal settings for every device, browser, file size, or network.
  Safari/Firefox, physical mobile devices, and live paid uploads were not
  benchmarked. Upload/payment regressions passed in the generated-WASM suite.

No blocking correctness regression was found in the inspected paths or the
checks above. ADR-0003 remains Proposed for human architectural review; no
package was published, branch pushed, or node deployed.
