# Windowed staging, private uploads, and payment modes — 2026-09-23

This audit validates [ADR-0005](../adr/ADR-0005-windowed-upload-staging.md)
(storage-bounded upload windows) and [ADR-0006](../adr/ADR-0006-private-uploads.md)
(private uploads), and the Merkle and single-node payment modes on both paths, in
real Chromium against a local browser-enabled devnet.

## Artifacts

- SDK: branch `feat/windowed-private-uploads` at `692322a` with the verification
  script [`2026-09-23-windowed-private-uploads-verification.mjs`](2026-09-23-windowed-private-uploads-verification.mjs).
- ant-core WASM: ant-client `f355fbde8f1a6339fef64052e722117531668cf6` on branch
  `feat/browser-record-batches-private-reads`, three commits on `origin/web-support`
  `5f46f34c` (`uploadRecords`, private DataMap reads, ADR-0004 amendment). Built
  from a clean worktree with `--no-default-features --features browser-wasm`.
  WASM SHA-256 `eca1f0200d0f5017ae867e799c19a6243c683813e301bac4dd52c418a098268d`;
  Cargo.lock SHA-256 unchanged at
  `54887c9f52216c51297468d2305343041aa1f5ffd332c8526f8654f132a971d7`.
- Nodes: ant-node `50167d39b8acc03ae771e790ef54b060a8d8ea72`, the revision the core
  pins, `ant-devnet` debug build from a detached worktree; 20 nodes with WebRTC
  Direct and a local Anvil chain.
- Browser: Chromium 151.0.7922.34 headless through playwright-core 1.62.1.
- Toolchain: wasm-pack 0.15.0, Node.js 22.23.1, Anvil 1.7.1, macOS.

## Commands

From the ant-client worktree:

```sh
cargo fmt --all -- --check
cargo clippy -p ant-core --target wasm32-unknown-unknown --no-default-features --features browser-wasm -- -D warnings
cargo clippy -p ant-core --target wasm32-unknown-unknown --no-default-features --features browser-wasm,test-utils -- -D warnings
(cd ant-core && wasm-pack build --target web --out-dir wasm-tests/pkg --release . \
  --no-default-features --features browser-wasm,test-utils \
  && node --import ./wasm-tests/setup-wasm.mjs --test ./wasm-tests/*.test.mjs)
python3 scripts/adr-governance.py
```

From the SDK root, sequentially:

```sh
ANT_CLIENT_DIR=../ant-client-web-support-uploads npm run sync:wasm
npm run check
npm run build:examples
npm pack --dry-run
python3 scripts/adr-governance.py
python3 .github/scripts/test_check_pr.py
ANT_DEVNET=<ant-node 50167d39>/target/debug/ant-devnet \
  node docs/audits/2026-09-23-windowed-private-uploads-verification.mjs
```

## Results

Shared core: formatting and both clippy configurations were clean, and all 157
generated-WASM tests passed. The six new ones cover consecutive record batches
that download as one public file, file-level progress positions, reported
payment modes, batch validation, private uploads that leave the DataMap unstored,
nested private DataMaps with range reads, and rejection of oversized or corrupt
DataMaps before any fetch. ADR governance passed.

SDK: `npm run check` built the package and passed typechecking and 185 tests in
21 files. All five examples built. `npm pack --dry-run` listed 89 files,
including the worker and the new window modules. ADR governance and the 52 PR
checker cases passed.

Real browser (`EXIT 0`, no page errors, served WASM matched the provenance hash):

| Scenario | Quota path | Windows | Records | Payments | Result |
| --- | --- | --- | --- | --- | --- |
| Demo, public 1 MiB | none | 1 | — | single | download matches |
| Demo, private 1 MiB | none | 1 | — | single | `.datamap` saved (328 bytes), page reloaded, download from the file matches |
| Public 40 MiB, `single` | `QuotaExceededError` ends windows | 2 (1–7, 8–15) | 15 | 2 single-node | download matches |
| Private 40 MiB, `auto` | estimate budget | 4 | 14 | 4 single-node | no address, 324-byte DataMap, download matches |
| Public 40 MiB, `merkle` | estimate budget | 4 | 15 | 4 Merkle on Anvil | `paymentMode: "merkle"`, download matches |
| Resume, 40 MiB | estimate budget | 2 before stop, 3 after | 15 | 1 + 3 | retained window reused, file re-encrypted to record 6, no repeat payment, download matches |
| Private in-memory 64 KiB | none | 1 | 3 | single | download from `{ dataMap }` matches |
| Incognito, 40 MiB | `QuotaExceededError` | 1, then failure | — | 1 | "Not enough browser storage", recovery retained |

The windowed scenarios used a fresh on-disk profile with
`Storage.overrideQuotaForOrigin` set to 30 MiB before any IndexedDB use. The
resume scenario cancelled the upload when the second window's preparation began,
before it was paid. `resumeUpload` uploaded that window's staged records again,
then a new worker re-encrypted the first six records and continued. The upload
made four payments in total, one per window.

## Findings

- Chromium enforces an overridden quota on IndexedDB writes, but
  `navigator.storage.estimate()` still reports the unmodified 10 GiB. With the
  real estimate, the SDK therefore relied on `QuotaExceededError` to end the first
  window at seven records. The estimate-bounded scenarios patched only the page's
  `estimate()` to report the enforced quota, giving three records per window.
- The override applies only to IndexedDB opened after it. It had no effect on a
  page whose staging database the demo had already opened.
- In an on-disk profile, deleting a window's records freed the quota at once, and
  the next window reused the space. In an incognito context, which keeps IndexedDB
  in memory, usage stayed at 28 MiB and writes kept failing for at least 120
  seconds after the records were deleted. A file larger than an incognito quota
  therefore fails after its first window; that window is paid and the upload is
  retained. This is recorded as a trade-off in ADR-0005 and in the README.
- Before this run, the worker reported IndexedDB exhaustion as a bare
  `QuotaExceededError` message. `692322a` now reports "Not enough browser storage
  to stage an upload window" and keeps the IndexedDB error as its cause.

## Limitations

- Only Chromium was exercised. Safari, where quota limits motivated windowing,
  and Firefox were not run.
- Quotas were imposed through the DevTools override, not by a small disk or a real
  private-browsing quota. The estimate-bounded path used a patched page estimate.
- Restarting from a persisted windowed checkpoint after a page reload was covered
  by SDK integration tests, not by this live run.
- Interoperability with native `.datamap` files follows from both sides using the
  same MessagePack DataMap bytes; the native CLI did not read a browser-written
  file, or the reverse, in this run.
- All traffic stayed on one machine; no WAN or mainnet measurements were taken.
