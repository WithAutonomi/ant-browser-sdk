# Finalized manifests from ant-client main — 2026-10-08

Updates SDK PR #6 after ant-client PR #219 merged. This supplements the
[draft-build streaming comparison](2026-10-06-manifest-streaming-comparison.md);
those measurements remain historical and were not rerun for this build.

## Changes

- Merged SDK main `1d572a2b5496595f034e4fb5155e7ac4e3bef199`, including
  atomic WASM sync, third-party notices and their provenance checks.
- Rebuilt the release WASM from a clean checkout of ant-client main
  `9a2b6353a88207dd4d6ed99a5158c370531a7e09` with its committed lockfile.
  This includes the finalized manifest format and identity rules plus pointer
  quorum/recovery fixes. The SDK does not expose pointer operations.
- Updated the mainnet fixture to the finalized v1 packed chunk layout. Draft
  links using self-encryption's serde layout now reject with `INVALID_SOURCE`
  and must be regenerated using the current CLI.
- Exposed the core's optional `ManifestEntry.knownSize`, derived from an
  embedded root DataMap. The creator's `size` remains an unverified display
  hint. Public entries and shrunk maps omit `knownSize`.

## Provenance

- SDK source tested: `6b93f2a7a947c59b3b5f29f640ed0a73c1459ee6`, version
  0.1.2, based on PR head `282808191d2ddd5a54e8da82a6ef863049495e44`.
  The browser run preceded the source commit and used exactly those files.
- WASM source: ant-client `9a2b6353a88207dd4d6ed99a5158c370531a7e09`,
  clean main checkout, `wasm32-unknown-unknown`, `browser-wasm`, no default
  features, release build.
- WASM SHA-256:
  `9e0792faf9fcecf18dba8e40f66c9b4c257109143f2bb60efddfe4de2bf5bbad`.
- Cargo.lock SHA-256:
  `8461f11d61ac05cfc8618e9c4dff3dd6273e528535685b36355d9161cbf8c6cd`.
- Node: clean ant-node `26129a2611cac08f9f53a557f91fb8806b40a1cc`, the
  upstream browser integration pin; `cargo build --locked --bin ant-devnet`.
- Node binary SHA-256:
  `01bcecaba013670fed87ec945fe7aa01d7cccbc952db79888a46e594a202925b`.
- Tools: Node v22.23.1, Rust 1.99.0, wasm-pack 0.15.0, Python 3.11.15,
  Anvil 1.7.1, Playwright 1.62.1. Exact Chromium version and notice checksums
  are retained in the evidence directory.

## Validation

- `npm run check`: build, typecheck and **202 tests in 22 files passed**.
  The seven manifest tests use production WASM, including the upstream golden
  v1 fixture, root-derived size, shrunk-map identity, torrent references,
  rejection of draft layouts, invalid headers and unsupported versions.
- `npm run verify:wasm`: passed for main ancestry and the binary, notice,
  generator and configuration checksums.
- `npm run build:examples`: all five examples built.
- `npm pack --dry-run --json`: passed, **94 files**, including both root
  licences, the WASM, generated bindings, provenance, and third-party notices.
- ADR governance passed. PR checker self-tests: **52/52 passed**. PR #6's
  existing `Closes V2-TBD` remains unchanged at the user's request; its Linear
  reference and associated template checks still need a real issue key.
- Real headless Chromium against seven isolated WebRTC nodes and local Anvil:
  - All-in-one demo: public and private Blob uploads, then downloads saved
    **13,056 matching bytes** each. The private flow saved and reloaded its
    `.datamap` file before downloading.
  - Finalized `.ant` fixtures and links decoded through the SDK to the exact
    upload identity. Embedded entries downloaded matching bytes for both
    files; the public reference also downloaded the public file correctly.
  - Embedded `knownSize` was 13,056 while the deliberately incorrect creator
    hint was 1; downloaded size came from the actual DataMap.
  - `openFile()` returned matching start, middle and tail ranges for both
    embedded entries. `createMediaSource()` with playback priming enabled
    returned matching head and tail ranges with HTTP 206 for both.
  - Every observed browser WASM response matched the recorded binary hash.
    No page or console errors. Clients, readers, media sources and browser
    contexts were closed; only task-owned servers were stopped.

## Limits

This run exercises Chromium, small root maps, paid uploads and byte-range
streaming on a devnet. It does not measure playback speed, test large nested
maps against live nodes, exercise pointer bindings, or establish native/browser
parity. The retained upstream mainnet fixture verifies shrunk-map decoding
without a network fetch. Earlier mainnet timing claims refer to earlier draft
WASM builds and do not characterize this rebuilt binary.

Commands, probes, compressed logs, provenance, browser results and checksums
are in [the evidence directory](2026-10-08-ant-client-main-sync/).
