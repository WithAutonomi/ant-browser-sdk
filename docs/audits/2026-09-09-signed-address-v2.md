# Signed address V2 — 2026-09-09

Unsigned V2 had not shipped, so it is replaced directly with mandatory owner
signatures. The SDK continues to use the shared portable saorsa-core verifier
and routing policy through ant-protocol and the ordinary ant-core Client.

## Protocol

- One capability: `addr-v2`, imported from saorsa-core by native and browser adapters.
- One V2 topic: `/dht/address/2.0.0`.
- `PublishAddressSetV2` contains a complete owner-signed address record.
- Every `NodesFoundV2` entry contains a mandatory owner-signed record; no separate
  unsigned fields can substitute for the signed peer identity or addresses.
- The unpublished unsigned V2 layout, separate signed operation variants,
  extra topic and extra capability are removed.
- V1 retains its original discriminants and serves older peers. A pending V2
  lookup cannot accept a V1 response as a downgrade.
- V2 omits peers whose current proof is unavailable. Browser lookup responses
  carry the proofs in bounded binary bodies and reject missing proofs when the
  authenticated server advertises `addr-v2`.
- Nonempty replacement semantics, unknown future transport payloads, one-hour
  proof expiry, periodic renewal and bounded decoding remain shared.

## Dependency revisions

- saorsa-core: `3a683af3394c5a59f624be77d6afcdf791f3d611`
- ant-protocol: `521b7bf79d3ebd8e35fd649fb18b40f5688af58c`
- ant-node: `e82500b950931cfcd33ea815e319309974a9f0ff`
- ant-client: `488d6dece3205d45d8c5e4263cf86cd310b0b2a9`
- saorsa-transport: `c6e3ee21d41caf332b3a64dd15d32123e486f8ac`

## Validation

- 573 saorsa-core library tests passed; strict all-target/all-feature Clippy and
  the portable WASM build passed.
- 79 ant-protocol tests and its portable WASM build passed.
- 23 native node WebRTC tests and strict library Clippy passed; node and devnet
  binaries were rebuilt with the final pins.
- 473 native ant-core tests, strict workspace Clippy, 86 generated-WASM tests
  and strict WASM Clippy passed.
- Regressions cover unsigned V2 rejection, signature/owner checks, omission of
  unproven peers, V1-to-V2 response downgrade rejection, full close-group bounds,
  browser proof omission, and the retained legacy hint fallback.

The rebuilt SDK passed `npm run check`: build, TypeScript checks and all 134
tests. Its recorded source revision, Cargo lock checksum and WASM checksum were
independently verified against the final ant-client commit.

Real Chromium authenticated the `addr-v2` capability against twenty rebuilt
nodes and an Anvil chain. It uploaded a 5,200-byte File through the browser worker,
paid for storage, downloaded identical bytes, read a 120-byte range, and forced
a Merkle payment with another byte-exact download. Logs: `/tmp/sdk-live-tTXYon`.
The first live attempt stopped while creating native transport for node 3;
a fresh-port retry passed. Test browser/devnet processes were stopped afterward.

Core, protocol, node and client changes are pushed as scoped commits on their
existing `web-support` branches. The SDK artifact is committed locally because
this checkout has no remote configured. saorsa-transport needs no code change;
its existing wire framing carries the V2 proof bundle.
