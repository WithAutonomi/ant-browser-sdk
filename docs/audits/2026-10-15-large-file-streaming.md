# Current ant-client core and large-file streaming — 2026-10-15

SDK PR #6 was checked against current upstream main and merged as
`29ab1758e1188fc445b82465949dcc655345935b`; see the
[manifest review](2026-10-15-manifest-main-review.md). This follow-up starts from
that merge on `feat/large-file-streaming-20261015`. The implementation tested is
SDK commit `456dbb7b6b6ccbcce0603bbae2fd7b1664b68975`.

## Changes

- Rebuilt production WASM from clean ant-client main
  `225a6768589ecbb6a0c77d70df329f343b22776f`, including large-file downloads,
  shared in-flight chunk fetches, current pointer fixes and dependency updates.
  High-level pointer APIs are outside this SDK change.
- Added typed `PublicFileReader.pipeTo(destination, options)` over the core's
  ordered, concurrent writable pipeline, with ranges, byte progress, BLAKE3,
  cancellation, backpressure and destination cleanup. Closing a reader cancels
  active pipes; WASM readers are freed only after their raw calls settle.
- Added `DownloadOptions.maxMemoryBytes` and forwarded download cancellation to
  Rust. Avoided an extra file-sized intermediate copy before Blob construction.
- Removed the 1 GB media cap in both the SDK and standalone service worker;
  byte positions are exact JavaScript safe integers. Added capability reporting
  for writable streaming and a disk-download/cancel flow to the all-in-one demo.
- Retained upstream's 1,000,000,000-byte browser upload limit. Exposed it as
  `SDK_LIMITS.maxUploadBytes`, keeping `maxFileBytes` as the compatible alias.
  `downloadAndSave()` retains its existing buffered bytes/Blob return value.
- Added [Proposed ADR-0008](../adr/ADR-0008-large-file-downloads-and-writable-streams.md).
  No Accepted ADR was changed. No new npm dependency.

## Revisions and provenance

- WASM and native CLI: ant-client
  `225a6768589ecbb6a0c77d70df329f343b22776f`, clean sources and committed lockfile.
- WASM SHA-256:
  `9298d1564f1809f97f06b3bacee3a674040ff74c6af1aa3366d1f0ba542a8352`.
- Cargo.lock SHA-256:
  `64a762b99db03f64e20bdb6699e5e576417dedbd6172049834c64fd27a068314`.
- Nodes: clean ant-node `26129a2611cac08f9f53a557f91fb8806b40a1cc`, upstream's
  browser integration pin. Built with `cargo build --locked --bin ant-devnet`.
- Seven isolated WebRTC-enabled nodes, three bootstrap nodes, ephemeral node
  ports, API port 39870, demo port 39871 and a local Anvil chain. Only task-owned
  servers and data were used.
- Node v22.23.1, Rust 1.99.0, wasm-pack 0.15.0, Python 3.11.15,
  Playwright 1.62.1, Chromium 151.0.7922.34.
- Exact generated provenance and WASM/JS/native-binary checksums are in the
  [evidence directory](2026-10-15-large-file-streaming/).

## Validation

- `npm run check`: build, TypeScript and **211 tests in 22 files passed**.
  Production WASM validates descriptors beyond 4 GiB/1024 chunks, the new
  download options, pre-aborted signals and the unchanged manifest fixtures.
  SDK regressions cover cancellation propagation, raw-call lifetime, caller
  edits to signal options, Blob view boundaries and service-worker ranges.
- `npm run verify:wasm`: passed main ancestry, binary and licence provenance.
- `npm run build:examples`: all five applications passed.
- `npm pack --dry-run --json`: passed prepack checks and packaged both root
  licences, the updated service worker and generated WASM notices.
- `python3 scripts/adr-governance.py`: passed.
- `python3 .github/scripts/test_check_pr.py`: 52/52 passed.

Real Chromium exercised the production SDK and WASM, without RTC/RPC mocks:

- Public/private Blob uploads through the all-in-one demo, saved downloads and
  private DataMap save/reload each preserved **13,056 bytes**. Embedded/public
  manifest entries, manifest links, three reader ranges and two HTTP 206 media
  ranges per visibility passed. Root-derived size remained correct despite a
  creator size hint of 1. Every observed WASM hash matched provenance.
- The new demo disk-download button wrote the public sample to a real OPFS
  `FileSystemWritableFileStream`, preserving all bytes and its hash. The picker
  was replaced by a function returning that handle for automation; the native
  picker dialog was not exercised.
- The native CLI uploaded the upstream **4,303,347,835-byte** fixture as
  **1,032 records**, with zero failed records, in about 50 seconds. Its address
  matched the fixture. Only the history record created by this probe was moved
  into the task directory; existing user upload history was preserved.
- Public and private readers returned correct bytes at the head, beyond 1 GB,
  across 4 GiB, and at EOF. Both buffered download paths rejected a 64 MiB
  output budget with `DOWNLOAD_FAILED` and streaming guidance.
- The whole large file streamed into OPFS with its exact size and BLAKE3
  `1b382a68936c50a2be8f4caa7f579c90cf649544a46f07ce5adeeffc20f5a3cd`.
  Progress reached the exact file size after 1,028 callbacks. Stored bytes
  around 4 GiB and at EOF matched; a private range also streamed correctly.
- A stalled destination write was cancelled both by the caller's signal and by
  closing the reader. Each pipe rejected promptly, released its writer lock and
  aborted the destination once the pending write settled.
- A media request crossing 4 GiB returned HTTP 206 and
  `Content-Range: bytes 4294967288-4294967303/4303347835`, with 16 correct bytes.
- Successful runs reported no page or console errors. Final browser summaries
  retain the exact SDK revision, WASM hash, timings and results.

## Limitations and operational notes

This is Chromium correctness evidence on a local devnet, not a mainnet or
cross-browser performance comparison. The large fixture repeats one byte and
compresses to about 67 KB of records; its disk-stream timing is not a realistic
network-throughput measurement. No Safari/Firefox playback or codec test, native
vs browser performance parity, pointer operation, or multi-gigabyte browser
upload is claimed. Shared-fetch and bounded-pipeline algorithms are upstream
implementations; this audit does not independently measure their GET counts or
peak memory. Resident map/index, cache, transport and destination memory are
additional to the pipeline's 32 MiB plaintext bound.

The first notice-generation attempt hit GitHub's unauthenticated rate limit and
installed no artifacts. The authenticated retry completed and passed provenance
verification. A final browser rerun initially hit Vite's dependency-optimization
page reload; the retained probe waits for network idle before starting evaluation.
This harness failure and the successful rerun are recorded separately.

Deploy the updated service worker with the SDK. Reverting requires reverting
the bindings, binary, provenance and licence notices together with the wrappers.
ADRs remain Proposed pending human engineering review.
