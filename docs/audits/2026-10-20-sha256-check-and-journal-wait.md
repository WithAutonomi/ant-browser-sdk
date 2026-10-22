# Manifest SHA-256 checks and wallets awaiting the journal — 2026-10-20

SDK `317a634b2fedddc8322c6fbf04b85ab73bbdbfc7` on `feat/large-file-streaming-20261015`
makes `download()` and `downloadAndSave()` check a manifest entry's recorded
`sha256`, and has wallets await `PaymentContext.submitted()` until the broadcast
is journaled. This run repeats the real-Chromium checks of the
[pointer, manifest and save audit](2026-10-15-pointer-manifest-save.md) against
the current bundle, the first real-browser run since `a4b6a53`, and adds checks
for both changes.

## Revisions

- SDK `317a634b2fedddc8322c6fbf04b85ab73bbdbfc7`, clean.
- WASM from ant-client `404fa3440c7529d2ab0e10ef200d960d619c0fd4`
  (WithAutonomi/ant-client#230 rebased onto main), SHA-256
  `e28ec0cda529ed404f0f22fb260aedbe6d9278e85484fd3e28658669bff08497`;
  provenance in [`source.json`](2026-10-20-sha256-check-and-journal-wait/source.json).
- Native CLI: release `ant` built from the same clean `404fa34`, SHA-256
  `49210762ede36e1bfdcd8215ddd1bcdfbdf3e4002b705c5f43203f5415d1bff0`.
- Node: clean browser integration pin `26129a2611cac08f9f53a557f91fb8806b40a1cc`,
  `ant-devnet` built with default features (including `webrtc-direct`), SHA-256
  `b605a66b8068c5f69984bdb96922207fd221da75c7033a1074f6df3c09438c03`.
- Node.js 22.23.1; Rust 1.99.0; Playwright 1.62.1; Chromium 151.0.7922.34;
  Anvil 1.7.1.

`npm run verify:wasm` **fails the expected main-ancestry gate**: `404fa34` is
not on ant-client main. Do not release until the WASM is rebuilt from main.

## Automated validation

- `npm run check`: build, TypeScript and **258 tests in 23 files passed**.
- `npm run build:examples`: all five Vite applications passed.
- `npm pack --dry-run --json`: prepack repeated the checks; 97 files.
- ADR governance (8 ADRs) and all 52 PR-checker cases passed.

## Real-browser and native evidence

Seven isolated WebRTC nodes and a local Anvil chain used ephemeral node ports,
API port 39970 and Vite port 39971. The script checks the local-chain identity
before using the public Anvil development key, and paces network operations by
1.5 seconds as before. Each 13,056-byte file had a fresh random 16-byte prefix,
so every upload paid rather than finding records an earlier run had stored.

Manifest SHA-256:

- Browser-created manifests for a public and an embedded private upload recorded
  the plaintext SHA-256. It was given in upper case and decoded in lower case
  from both the `.ant` bytes and the link.
- `download()` returned the bytes when the entry's claim matched them. For the
  same entry with a well-formed wrong claim, it failed with `DOWNLOAD_FAILED`
  naming both hashes.
- `downloadAndSave()` saved matching bytes through the picker. With the wrong
  claim it failed with `DOWNLOAD_FAILED`, opened no writable, and removed the
  empty picked file.
- `streamAndSave()` wrote all bytes under the wrong claim too, as documented:
  streaming saves do not check it. Their BLAKE3 matched the upload.
- The native CLI at `404fa34` decoded all four browser-created `.ant` files with
  the same `sha256`. `ant manifest download` from the devnet wrote both files,
  hashing to the recorded values, and refused both wrong claims with "SHA-256
  mismatch", writing nothing.

Wallets awaiting the journal:

- An observed Ethers wallet paid for the public upload, the private upload and a
  pointer creation. Each journal callback took 1.5 seconds to persist the
  checkpoint carrying the broadcast: in hex MessagePack for the upload, in JSON
  for the pointer. `submitted()` settled 1,507 to 1,509 ms after the broadcast,
  within 1 ms of that checkpoint persisting, and the wallet returned 13 to 17 ms
  later.

Pointers and recovery:

- Creation returned counter `0`, update `1` and transfer
  `18446744073709551615`. Finality reported **7 answered / 7**, one final state
  transferred to the recipient. Replaying the paid state kept its state ID.
- Same page: a wallet that threw after a real confirmed transaction no longer
  fails the write. Since `a4b6a53` the write observes the broadcast through its
  `wait()` and stores it. The pointer read back at counter `0`, its checkpoint
  holds the paid state, and one payment was made.
- Lost page: page A's wallet broadcast, awaited `submitted()`, then never
  returned, and page A was closed. Its checkpoint already held the transaction
  and no paid state. A fresh page B, whose wallet failed any payment attempt,
  resumed from that checkpoint through the Ethers provider's `recover()`, then
  stored the pointer at counter `0` and read it back. Payments: **one on page A,
  none on page B**.
- Cancellation of a supplied streaming destination rejected with AbortError,
  aborted it once and released its writer lock.

Demo: the all-in-one export button downloaded a valid 91-byte `.ant` file
matching its link, and the Stream to disk button saved 13,056 correct bytes to
OPFS. Pickers were automated; native dialogs were not.

Every page had no errors, and every WASM response matched the bundled hash.
Scripts, summaries, logs, the four `.ant` files and native outputs are in
[the evidence directory](2026-10-20-sha256-check-and-journal-wait/). The `dist`
hashes there are of the build `npm run check` produced from the same clean
source after the run.

## Changes from the 2026-10-15 script

- The embedded entry carries no size hint. Since ant-client `973ae93` the core
  refuses one contradicting the root map, such as that script's deliberate hint
  of 1.
- The recovery check is split into same-page confirmation and a lost page,
  because the write now confirms a same-page broadcast itself.
- Each file has fresh content, and three wallets are observed with a slow journal.

## Runs and limits

Six runs used the same devnet; the sixth passed every check. The first, third,
fourth and fifth stopped at the script issues above: the size hint, the
same-page recovery, uploads that found their records already stored and did not
pay, and looking for the upload checkpoint's hash as plain hex. The second
stopped when a paid pointer update was stored on 4 of 5 close-group peers after
a WebRTC dial dropped ("close-group PUT shortfall (dial churn)"); its checkpoint
was not resumed. That failure is in the core's store after payment, like the
DataChannel closure in the earlier audit; its log is
[kept](2026-10-20-sha256-check-and-journal-wait/browser-dial-churn.log.gz).
This run does not establish its rate.

This is local Chromium correctness evidence, not a mainnet, cross-browser or
throughput claim. Only the Ethers provider ran; the Wagmi provider, Merkle
payments, the 30-second bound and a missing WebCrypto are covered by unit tests
only. The pages ran on `http://127.0.0.1`, a secure context. The 4.3 GB
pipeline of the [large-file audit](2026-10-15-large-file-streaming.md) was not
repeated.
