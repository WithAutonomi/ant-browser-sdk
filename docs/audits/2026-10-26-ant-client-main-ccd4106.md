# WASM rebuilt from ant-client main `ccd4106` — 2026-10-26

ant-client main moved to `ccd4106dd8fd60545bbd31c40d46cc041f85fb8d`: the 0.14.0
release (WithAutonomi/ant-client#240), which removed the `[patch.crates-io]`
testnet pins the [2026-10-22 audit](2026-10-22-ant-client-main-8b19c14.md)
recorded, and two dependency updates for RustSec advisories (#233, #236). The
bundled WASM is rebuilt from it for the 0.1.3 release, and the same checks were
repeated with the same scripts.

## What the rebuild changes

No browser, data or read-engine source changed since `8b19c14`. The bundle now
builds every crate from crates.io: `saorsa-transport` 0.38.2 instead of git
revision `520dd3e`, `ant-protocol` 5.0.1 and `saorsa-core` 0.29.2. The pinned
`ant-node` 0.23.1 is still only a dev-dependency there. The JS bindings are
byte-identical; only the WASM, the licence notices and `source.json` change.
The 2026-10-22 caveat that the release ships an unreleased transport revision no
longer applies.

## Revisions

- SDK `8c00e820feea25d344c9b83bad8466740c52fbdb` with the rebuilt `src/wasm`, as
  committed together with this audit.
- WASM from clean ant-client main `ccd4106dd8fd60545bbd31c40d46cc041f85fb8d`,
  SHA-256 `08ae5d0cc7b96458ba9899d68be0455b276848644237f42704419a2e4311fec4`;
  provenance in [`source.json`](2026-10-26-ant-client-main-ccd4106/source.json).
- Native CLI: release `ant` built from the same main revision, SHA-256
  `28298c368722397cd21ebe5ac5e68a74b3b5b6b3739e7dfef3fe2a2ebb0a55d6`.
- Node: browser integration pin `26129a2611cac08f9f53a557f91fb8806b40a1cc`, which
  main's browser tests still pin; the same `ant-devnet` binary as before.
- Node.js 22.23.1; Rust 1.99.0; wasm-pack 0.15.0; Playwright 1.62.1; Chromium
  151.0.7922.34.

## Automated validation

- `npm run verify:wasm` **passed**: `ccd4106` is on main, and the binary and
  licence hashes match.
- `npm run check`: build, TypeScript and **258 tests in 23 files passed**.
- `npm run build:examples`: all five Vite applications passed.
- `npm pack --dry-run --json`: `withautonomi-ant-browser-sdk-0.1.3.tgz`, 97 files.
- ADR governance (8 ADRs) and all 52 PR-checker cases passed.

## Real-browser and native evidence

Seven isolated WebRTC nodes and a local Anvil chain, set up and paced as before.
The scripts of the [2026-10-20 audit](2026-10-20-sha256-check-and-journal-wait.md)
passed on their first run:

- Manifest SHA-256 for a public and an embedded private upload: `download()` and
  `downloadAndSave()` accepted the recorded claim and refused a wrong one with
  `DOWNLOAD_FAILED`, opening no writable; `streamAndSave()` wrote all bytes under
  either claim, as documented.
- The native CLI at `ccd4106` decoded the four browser-created `.ant` files with
  the same `sha256`, downloaded both files from the devnet hashing to the
  recorded values, and refused both wrong claims.
- Wallets awaiting the journal: `submitted()` settled 1,507 to 1,509 ms after the
  broadcast, when the deliberately slow checkpoint carrying it persisted.
- Pointers: counters `0`, `1` and `18446744073709551615`; finality **7 answered /
  7**; a same-page confirmation with one payment; a lost page recovered by a
  fresh page with **one payment on the lost page and none on the recovering
  page**.
- Streaming cancellation and the all-in-one demo's export and Stream to disk
  buttons passed.

No page errors; every WASM response matched the bundled hash. Summaries, logs,
`.ant` files and native outputs are in
[the evidence directory](2026-10-26-ant-client-main-ccd4106/).

## Limits

As before: correctness against nodes at the browser integration pin, not
mainnet; Chromium only; the Wagmi provider, Merkle payments, the 30-second
journal bound and a missing WebCrypto are covered by unit tests.
