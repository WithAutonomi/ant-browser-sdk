# WASM rebuilt from ant-client main `8b19c14` — 2026-10-22

WithAutonomi/ant-client#230 merged into main as `8b19c1499360ebd8166a1ef3dd65b88db914dd7f`.
The SDK's bundled WASM is rebuilt from that clean main revision for the 0.1.3
release, and the checks of the
[2026-10-20 audit](2026-10-20-sha256-check-and-journal-wait.md) were repeated
against it with the same scripts.

## What the rebuild brings

The previous bundle came from `404fa34`, which reached main through #230. Main
adds, for the browser build:

- `93f3bd2`: the core checks unknown keys on any JavaScript object, including
  one without `Object.prototype` or from another frame. The SDK already passes
  its own option objects and `structuredClone` copies, so its behavior does not
  change.
- WithAutonomi/ant-client#225: hot-record reads spread across the close group
  and back off briefly from nodes that decline.
- `a205d06`: a `[patch.crates-io]` pinning `saorsa-transport` and `ant-node` to
  git revisions for ADR-0023 testnet builds, to be removed once those crates are
  published. `cargo tree` for the browser target shows `saorsa-transport` as a
  normal dependency, so the bundle now contains `saorsa-transport 0.38.1` from
  `https://github.com/WithAutonomi/saorsa-transport` at
  `520dd3ef7540b1743e644ecdd8a74f2b58ec43a9` instead of the crates.io release.
  The licence notices record that source. `ant-node` is only a dev-dependency
  there and is not bundled.

The JS glue gains an import reading a peer connection's ICE state and loses the
`instanceof Object` import `93f3bd2` no longer uses; the rest is renumbered
closures and reordered internal exports. The bindings' exports and the SDK's
public API are unchanged.

## Revisions

- SDK `317a634b2fedddc8322c6fbf04b85ab73bbdbfc7` with the rebuilt `src/wasm` and
  the 0.1.3 version, as committed together with this audit.
- WASM from clean ant-client main `8b19c1499360ebd8166a1ef3dd65b88db914dd7f`,
  SHA-256 `0c01cd4377a4b4846ae989691317738b909a83ce95e81ea62ce1833391a794a8`;
  provenance in [`source.json`](2026-10-22-ant-client-main-8b19c14/source.json).
- Native CLI: release `ant` built from the same main revision, SHA-256
  `50d4916d5a8a42dbdd761f5d7a498a7587a503df1ede66acec5e0696589322ec`.
- Node: clean browser integration pin `26129a2611cac08f9f53a557f91fb8806b40a1cc`,
  which main's browser tests still pin; the same `ant-devnet` binary as the
  2026-10-20 audit.
- Node.js 22.23.1; Rust 1.99.0; wasm-pack 0.15.0; Python 3.11; Playwright 1.62.1;
  Chromium 151.0.7922.34; Anvil 1.7.1.

## Automated validation

- `npm run verify:wasm` **passed**: `8b19c14` is on main, and the binary and
  licence hashes match.
- `npm run check`: build, TypeScript and **258 tests in 23 files passed**.
- `npm run build:examples`: all five Vite applications passed.
- `npm pack --dry-run --json`: `withautonomi-ant-browser-sdk-0.1.3.tgz`, 97 files.
- ADR governance (8 ADRs) and all 52 PR-checker cases passed.

## Real-browser and native evidence

Seven isolated WebRTC nodes and a local Anvil chain, set up and paced as in the
2026-10-20 audit. The first run passed every check:

- Manifest SHA-256, for a public and an embedded private 13,056-byte upload:
  `download()` returned bytes meeting the recorded claim and failed a wrong claim
  with `DOWNLOAD_FAILED`; `downloadAndSave()` saved matching bytes and, for a
  wrong claim, opened no writable and removed the empty picked file;
  `streamAndSave()` wrote all bytes under either claim, as documented.
- The native CLI at `8b19c14` decoded all four browser-created `.ant` files with
  the same `sha256`, downloaded both files from the devnet hashing to the
  recorded values, and refused both wrong claims with "SHA-256 mismatch".
- Wallets awaiting the journal: for the public upload, the private upload and a
  pointer creation, `submitted()` settled 1,506 to 1,509 ms after the broadcast,
  when the deliberately slow checkpoint carrying it persisted, and the wallet
  returned 14 or 15 ms later.
- Pointers: counters `0`, `1` and `18446744073709551615`; finality **7 answered /
  7**, one final state; paid replay kept its state ID.
- A wallet throwing after a real transaction: the write confirmed it on the same
  page, with one payment. A page lost after its broadcast was journaled: a fresh
  page recovered the pointer through Ethers `recover()`, with **one payment on
  the lost page and none on the recovering page**.
- Streaming cancellation rejected with AbortError, aborted once and released its
  lock. The all-in-one demo exported a valid 91-byte `.ant` matching its link and
  streamed 13,056 correct bytes to OPFS.

No page errors; every WASM response matched the bundled hash. Summaries, logs,
`.ant` files and native outputs are in
[the evidence directory](2026-10-22-ant-client-main-8b19c14/); the scripts are
those of the 2026-10-20 evidence directory.

## Limits

The run checks correctness against nodes at the browser integration pin, not
against the ADR-0023 node tip the transport pin targets, nor mainnet. It does not
measure the effect of #225 on read performance. Only the Ethers provider ran in
a browser; the Wagmi provider, Merkle payments, the 30-second journal bound and a
missing WebCrypto are covered by unit tests. The release bundles a transport
revision that is not a crates.io release; a later main without the patch should
be released with a rebuilt bundle.
