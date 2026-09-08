# SDK shared-core integration — 2026-09-08

The SDK now bundles release WASM from ant-client `a5a55c6ca0d76a45dcf6ba26876d4c63cf6babb4`,
with `--no-default-features --features browser-wasm`. The source worktree was
clean. `src/wasm/source.json` records the source and artifact checksums.

This artifact uses the ordinary ant-core Client and imports ant-protocol,
saorsa-core, saorsa-pqc, and evmlib. Iterative DHT lookup now lives in
`saorsa_core::dht_lookup`; the standalone `saorsa-dht-lookup` package is absent
from the dependency graph. WebRTC framing, session crypto, and handshake
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
  ant-node instances from `6950570d6d44bc84b05c9766baa15f6ce8747120` and a disposable
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

- ant-core: 472 native tests and strict workspace Clippy passed.
- Generated WASM: 75 tests passed after removing duplicated payment definitions and sharing
  the native lookup defaults.
- saorsa-core: 561 native tests and 76 portable tests passed.
- New recovery coverage includes interrupted wallet callbacks, staged byte-loader
  failure after payment, persistence-hook failure before payment, input/network
  mismatch, changed quotes after restart, and separate transactions per quote.

This shares single-node upload state and recovery. Native Merkle mode selection
and filesystem APIs are not newly exposed in the browser facade. Applications
own durable checkpoint/input storage; unresolved wallet submissions still need
settlement observation through the SDK payment reconciliation APIs. Browser
cancellation and native filesystem resume are not claimed to be identical.

Pinned dependencies: saorsa-core `acd4a50e668c4da59880439ca7d32f7484efd39b`,
ant-protocol `3cf4fe61664747f18c2d9247ff1400c6ea7e4171`, and saorsa-transport
`0ce2ea865242942b09a40cd0cea03ff0d0557065`.

## Canonical protocol definitions

Removed `saorsa-transport/src/webrtc/payment.rs` entirely. Browser and native
client policy import close-group size and majority from ant-protocol. Commitment
types, bounds, domain tags, canonical signing bytes, verification and hashing all
come from ant-protocol; the native node signer uses that payload builder too.
Pricing uses ant-protocol's original curve. Quote hashing delegates to the same
evmlib function used by `PaymentQuote::hash`, and quote signing uses its native
encoding. ML-DSA key length comes from saorsa-pqc. Browser test fixtures use these
same native definitions, with no separate portable commitment or pricing model.

Lookup K, concurrency and iteration grace defaults are shared through saorsa-core.
Transport framing/deadline limits and browser memory/pool settings remain in their
respective adapters. These changes introduce no WASM node services.

Additional validation: 60 portable transport tests, 8 portable evmlib tests,
79 protocol tests, and 70 targeted native node commitment/WebRTC tests passed.
Native and WASM client Clippy passed with warnings denied. The rebuilt SDK passed
131 tests, all five example builds, package inspection, and the real Chromium
payment/upload/download/range check described above.

EVM dependency: `545c6fa48cb05fecc411bed2d9d0a47d82ede6d1`.
