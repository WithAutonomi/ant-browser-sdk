# Pointer recovery, manifest export and streaming saves — 2026-10-15

SDK implementation `461dc2f8f17080eb8100edd8fa5063e1df1ae7a8` on `feat/large-file-streaming-20261015`
adds the three follow-ups to the [large-file work](2026-10-15-large-file-streaming.md).
Chromium revalidated the committed runtime. The recovery fixture was captured
in an earlier successful run with the same production WASM build.

## Changes and compatibility

- Typed pointer address, read, resolve, create, update, transfer, finality and
  resume APIs. Counters remain decimal u64 strings, and all five finality states
  remain visible. Long-running operations expose cancellation and progress.
- Required durable `onCheckpoint` persistence before pointer payment. Checkpoints
  retain the original signed state, verified payment plan, pinned network,
  submissions, receipt and paid proof, never the owner seed. Recovery observes an
  existing transaction or reuses its proof; it never calls `pay`. Client closure
  retains the network until pending pointer work settles. Stalled persistence
  callbacks are bounded without preventing storage of a state already paid for.
- Rust-backed `createManifest` and `createFileLink`, canonical `.ant` bytes,
  compact links, validated paths/torrent metadata and link-size guidance. The demo
  exports a manifest and displays its share link.
- `streamAndSave` owns picker selection, bounded piping and reader cleanup, accepts
  file handles or supplied writable streams, and returns bytes written plus hash.
  The demo uses this method. Existing `downloadAndSave` results remain compatible.
- Additive SDK APIs and a new versioned, application-owned opaque pointer checkpoint.
  No changes to network records, manifest v1 encoding, file storage or node policy.
  No new npm dependency. Proposed ADRs 0007/0008 were extended and 0009 was added;
  no Accepted ADR was edited or accepted autonomously.

## Revisions and release dependency

- ant-client companion branch `feat/browser-pointer-recovery-manifest-export-20261015`:
  clean `8316468b7f5f813457f195bccb16a452426d5f35`, based on main
  `225a6768589ecbb6a0c77d70df329f343b22776f`. It adds the manifest construction
  exports, awaited pre-payment pointer checkpoint and offline paid-proof recovery.
- WASM SHA-256: `6b2e4499fafaca8502be7b8a4447cfae78cf044b2b181e1527fb3d21b07edfd9`.
- Cargo.lock SHA-256: `64a762b99db03f64e20bdb6699e5e576417dedbd6172049834c64fd27a068314`.
- Node: clean browser integration pin
  `26129a2611cac08f9f53a557f91fb8806b40a1cc`.
- Native manifest decoder: the previously built CLI from ant-client main
  `225a6768589ecbb6a0c77d70df329f343b22776f`; exact binary hash is retained.
- Node.js 22.23.1; Rust 1.99.0; wasm-pack 0.15.0; Python 3.11.15;
  Playwright 1.62.1; Chromium 151.0.7922.34.

`npm run verify:wasm` **fails the expected main-ancestry gate**: the companion
commit is on its feature branch, not ant-client main. Binary and licence hashes
match; the source is clean. Do not release this SDK until the Rust changes are
merged to main and WASM is rebuilt from that main revision. The gate was not
weakened. Both feature branches are intended for review, not a published release.

## Automated validation

- `npm run check`: build, TypeScript and **230 tests in 23 files passed**.
- `npm pack --dry-run --json`: prepack repeated those checks successfully;
  97 files include both licences, pointer declarations, WASM and notices.
- `npm run build:examples`: all five Vite applications passed.
- SDK and ant-client ADR governance passed. PR-checker tests: 52/52 passed.
- `cargo test -p ant-core --lib`: **839 tests passed**.
- Native all-target/all-feature ant-core clippy and browser-WASM clippy passed
  with `-D warnings`; formatting passed. The dependency future-incompatibility
  notice for proc-macro-error2 is unchanged upstream.
- Production-WASM tests round-trip mixed manifests, reject unsafe paths,
  collisions, malformed maps/hashes and inexact size hints. A real devnet
  checkpoint rebuilds the exact original proof offline; changed signatures,
  state/payment-plan mismatches, unsupported versions and missing transactions
  reject. This fixture contains public signed records and local-chain evidence,
  not owner seeds.
- SDK regressions cover checkpoint failure before payment, failure/timeouts after
  payment, interrupted confirmation, no repayment, wrong-network recovery,
  cancellation, reader cleanup and deferred network freeing during settlement.

## Real-browser and native evidence

Seven isolated WebRTC nodes and a local Anvil chain used ephemeral node ports,
API port 39970 and Vite port 39971. The script checks the local-chain identity
before using the public Anvil development key. Only task-owned processes and
storage were used.

- Public and private uploads each round-tripped **13,056 bytes** through
  browser-created manifests and compact links, then `streamAndSave` into real
  OPFS writable files. Size and BLAKE3 matched. The private root map derived size
  13,056 despite its deliberately incorrect creator hint of 1.
- The unchanged native CLI decoded both browser-created `.ant` files with the
  same address, kind, path and size information.
- Pointer creation returned counter `0`, update `1`, reads and chain resolution
  matched. Permanent transfer returned counter `18446744073709551615`; finality
  reported **7 answered / 7 holders**, one final state, with the correct recipient.
  Replaying the retained paid state preserved its state ID.
- A payment adapter deliberately threw after a real confirmed transaction. The
  checkpoint retained broadcast evidence, and `resumePointer` recovered through
  Ethers receipt observation and stored the original signed state. The payment
  submission count stayed **exactly one**. Superseded: since `a4b6a53` the write
  confirms such a broadcast on the same page itself; the
  [2026-10-20 audit](2026-10-20-sha256-check-and-journal-wait.md) covers that
  and recovery from a lost page.
- Cancellation of a supplied streaming destination rejected with AbortError,
  aborted it once and released its writer lock.
- The actual all-in-one export button downloaded a valid `.ant` file and displayed
  its equivalent link. The Stream to disk button saved 13,056 correct bytes to
  OPFS. Automated pickers returned real file handles; native picker dialogs were
  not automated.
- Successful browser runs had no page errors and observed the exact recorded
  WASM hash. Full scripts, summaries, commands, hashes and compressed logs are in
  [the evidence directory](2026-10-15-pointer-manifest-save/).

## Limits and observations

An initial rapid run stopped before payment after a lookup found only two of
seven required peers; another closed a DataChannel during a pointer read.
Upstream's browser harness documents a 16-request/second node session limit and
paces instant-Anvil pointer operations by 1.5 seconds. Applying the same pacing
and connecting through all devnet seeds passed. No node admission rule or SDK
network policy was bypassed; this does not establish sustained burst performance.

This is local Chromium correctness evidence, not a mainnet/cross-browser or
throughput claim. The preceding audit covers the 4.3 GB pipeline; this follow-up
validates the new convenience API with small real files and does not repeat that
large fixture. Checkpoint durability depends on the application's callback and
storage; page termination can still hide a transaction hash between broadcast
and persistence. Such an outcome remains unresolved and never authorizes an
automatic second payment. Future SDK releases must first satisfy main provenance.
