# SDK shared-core integration — 2026-09-08

The SDK now bundles release WASM from ant-client `4f6f9e7a293010f02d8539786866b1fa37db8161`,
with `--no-default-features --features browser-wasm`. The source worktree was
clean. `src/wasm/source.json` records the source and artifact checksums.

This artifact uses the ordinary ant-core Client and imports ant-protocol,
saorsa-core, saorsa-pqc, and evmlib. Iterative DHT lookup now lives in
`saorsa_core::dht_lookup`; the standalone `saorsa-dht-lookup` package is absent
from the dependency graph. WebRTC framing, session crypto, and portable
verification now come from `saorsa_transport::webrtc` with the `webrtc` feature;
the standalone `saorsa-webrtc` package is also removed. Native ICE/DTLS/SCTP
dependencies remain outside the WASM graph. The upload API adds optional checkpoint persistence and restoration arguments.
Connection checks require the authenticated bootstrap node to advertise
`chunk_protocol`; older nodes fail before a network client or wallet flow starts.

## Validation

- `npm run check`: build, TypeScript checks, and 131 tests passed.
- `npm run build:examples`: all five examples built with the refreshed WASM.
- `npm pack --dry-run`: package includes WASM, generated bindings, and provenance.
- Real headless Chromium exercised the private-key example against seven local
  ant-node instances from `fe5769b9f5031acdb052188f7ace8d63e9ba3388` and a disposable
  Anvil chain. The UI authenticated a node, paid and uploaded a 5,200-byte File
  using the upload worker. A second SDK client downloaded identical bytes and
  verified a 120-byte range. The processes were stopped after the check.

## Shared client policy and recovery

Native and browser clients now use `saorsa_core::client_routing` for report
selection, publish-sequence precedence, quorum, and witness normalization. The
browser wire adapter carries complete native peer records; peers without WebRTC
endpoints still participate in witness views. Node listeners and maintenance
services remain native-only.

The portable Rust `UploadState` retains single-node payment plans and confirmed
proofs. Native finalization, native receipt reuse, and browser recovery share
these transitions and freshness rules. The SDK exposes `checkpoint` and an
awaited `onCheckpoint` callback, retaining the same state for `resumeUpload`.
Applications can persist checkpoints and restore them with the same file input.
Prepared checkpoints preserve exact quote hashes after a wallet interruption;
paid checkpoints reuse confirmed proofs even when discovery returns new quotes.
Wallets may return per-quote transaction hashes for split payments.

- ant-core: 473 native tests and strict workspace Clippy passed.
- Generated WASM: 75 tests passed; all four recovery tests also passed after the
  final checkpoint validation and memory changes.
- saorsa-core: 561 native tests and 76 portable tests passed.
- New recovery coverage includes interrupted wallet callbacks, staged byte-loader
  failure after payment, persistence-hook failure before payment, input/network
  mismatch, changed quotes after restart, and separate transactions per quote.

This shares single-node upload state and recovery. Native Merkle mode selection
and filesystem APIs are not newly exposed in the browser facade. Applications
own durable checkpoint/input storage; unresolved wallet submissions still need
settlement observation through the SDK payment reconciliation APIs. Browser
cancellation and native filesystem resume are not claimed to be identical.

Pinned dependencies: saorsa-core `3b4ce11930fcf59361120f20ffb47e3810daa674`,
ant-protocol `63c8525563e14f48374d52f7079bad8530e8b62b`, and saorsa-transport
`a2c6f4b165410015ee639178c9941610c6e2d164`.
