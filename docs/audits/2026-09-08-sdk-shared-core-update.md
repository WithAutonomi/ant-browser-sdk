# SDK shared-core integration — 2026-09-08

The SDK now bundles release WASM from ant-client `9525042d10fd816dcb6468184171746ea6ada3dd`,
with `--no-default-features --features browser-wasm`. The source worktree was
clean. `src/wasm/source.json` records the source and artifact checksums.

This artifact uses the ordinary ant-core Client and imports ant-protocol,
saorsa-core, saorsa-pqc, and evmlib. Iterative DHT lookup now lives in
`saorsa_core::dht_lookup`; the standalone `saorsa-dht-lookup` package is absent
from the dependency graph. WebRTC framing, session crypto, and portable
verification now come from `saorsa_transport::webrtc` with the `webrtc` feature;
the standalone `saorsa-webrtc` package is also removed. Native ICE/DTLS/SCTP
dependencies remain outside the WASM graph. TypeScript API signatures are unchanged.
Connection checks require the authenticated bootstrap node to advertise
`chunk_protocol`; older nodes fail before a network client or wallet flow starts.

## Validation

- `npm run check`: build, TypeScript checks, and 129 tests passed.
- `npm run build:examples`: all five examples built with the refreshed WASM.
- `npm pack --dry-run`: package includes WASM, generated bindings, and provenance.
- Real headless Chromium exercised the private-key example against seven local
  ant-node instances from `b3092ca47114b1d48b039bbaefa96fce6eea2897` and a disposable
  Anvil chain. The UI authenticated a node, paid and uploaded a 5,200-byte File
  using the upload worker. A second SDK client downloaded identical bytes and
  verified a 120-byte range. The processes were stopped after the check.

These tests establish SDK integration with the shared Client. They do not claim
that JS wallet/session recovery or browser cancellation matches native filesystem
resume. The earlier parity audit remains a historical record of its specified
baseline, rather than evidence against this replacement artifact.
