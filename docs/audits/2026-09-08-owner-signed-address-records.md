# Owner-signed address gossip — 2026-09-08

The SDK is rebuilt from a clean ant-client worktree using
`--no-default-features --features browser-wasm`. `src/wasm/source.json` records
the exact source revision, Cargo lock checksum, and release WASM checksum.

## Dependency revisions

- saorsa-core: `f3a7934baf0036bf0590f95c1a279641e202dccd`
- saorsa-transport: `c6e3ee21d41caf332b3a64dd15d32123e486f8ac`
- ant-protocol: `00376d52d015f35f92dfd5c163d9d6b3bb87c121`
- ant-node: `600eda6e91af92460ff803bda0d3ad7bcae4a19b`
- ant-client: `1b3ff1b6a7763db4d835a1ee0e0e792099b39990`

## Shared behavior

`saorsa_core::signed_address` signs and verifies complete nonempty address sets
with the existing ML-DSA-65 node identity. The signature binds owner, sequence,
issue time, expiry, and all opaque future transport records. Native and WASM
clients use the same verifier and routing selection rules. Local provenance is
never accepted through deserialization. Final result assembly also preserves
an already owner-proven candidate when other reports contain only hints.

Original signed records survive forwarding without rewriting. Derived views
apply shared address validity and reachability rules. Unsigned forwarded V1/V2
metadata cannot establish an authoritative sequence or replace a known owner
view. Direct authenticated legacy owner publications remain supported.

Native peers negotiate the signed address capability; browser FIND_NODE requests
opt into length-delimited binary proofs. Existing JSON header limits remain
unchanged. Signed native envelopes and all proof collections have explicit
bounds. Owners periodically renew unchanged records before their one-hour expiry.
There is no empty withdrawal; supplemental-only replacements preserve the last
native QUIC projection.

The signature establishes who advertised an address, not independent endpoint
reachability. Sequence caches are bounded and in memory; they do not provide a
persistent replay ledger across eviction or process restart. Older clients retain
their old trust behavior until upgraded.

## Validation

- saorsa-core: 571 native library tests; strict all-target/all-feature Clippy.
- ant-protocol: 79 tests; portable WASM check with the final core pin.
- ant-core: 473 native library tests; strict workspace Clippy; 84 generated-WASM
  tests with the final shared policy, plus the final WASM build check.
- Browser regressions cover original-proof forwarding, metadata substitution,
  tampering, expiry, duplicate owners, legacy hints, paid recovery, and lookup.
- ant-node: 23 WebRTC tests; strict library Clippy; final node/devnet binaries built.
- saorsa-transport: native WebRTC tests and portable WASM build passed.

The wider ant-node Clippy run is blocked by 19 pre-existing test-only findings:
18 duration-unit style warnings and one `map_or` simplification. The changed
library code passes strict Clippy. Those unrelated test files were not changed.

The final SDK passed `npm run check`: build, TypeScript checks, and all 134 tests.
Source revision and lock/WASM checksums were independently verified.

Real headless Chromium ran the private-key SDK example against twenty rebuilt
local nodes and a disposable Anvil chain. It authenticated the signed-address
capability, paid and uploaded a 5,200-byte File through the worker, downloaded
identical bytes, read a 120-byte range, then forced a Merkle payment and checked
another byte-exact download. The devnet and browser processes were stopped after
the check. Logs: `/tmp/sdk-live-X0Hps4`.

Implementation and dependency commits are pushed on each existing `web-support`
branch. The SDK artifact and these notes are committed locally; this SDK checkout
has no remote configured.
