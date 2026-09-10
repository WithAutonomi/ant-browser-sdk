# Lookup and address review fixes — 2026-09-10

The bundled WASM is rebuilt from ant-client `6fa0889d19c7454c437ab78164307bbd81893760`.
`src/wasm/source.json` records the clean source revision, Cargo.lock hash, and
WASM hash. Dependencies are pinned to saorsa-core `68a4a16`, ant-protocol
`7d40a94`, and ant-node `0cb2433e`.

## Behavior

- Native and browser iterative lookups share an overall 120-second deadline.
  Runtime timers are supplied to the shared runner; all pending adapter awaits,
  including the first response, are covered. Expiration cancels the walk and
  reports an explicit timeout. A zero-count lookup completes without queries.
- Address publication accepts supplied QUIC and WebRTC endpoints, merges
  registered supplemental endpoints, and rejects unsupported or invalid inputs
  before sending. Oversized sets are rejected rather than silently truncated.
- Core declares Rust 1.91 and CI checks native and portable WASM on that version.
- Browser peers use the current non-expiring, owner-signed V2 format. This
  supersedes the expiry/renewal behavior recorded in the September 8–9 audits.
  Browser RPC's `addr-v2` capability is defined in ant-protocol; native DHT
  peers send both versions without user-agent capability negotiation.

## Validation

- Core: 588 library tests, strict panic/unwrap/expect Clippy, Rust 1.91 native
  and portable WASM checks, and formatting passed.
- Protocol: 79 library tests and portable WASM check passed.
- Node: 23 WebRTC tests and strict library Clippy passed.
- Client: 473 native tests, 88 generated-WASM tests, and native/WASM Clippy
  with warnings denied passed. New WASM tests exercise a never-resolving
  callback and a zero-count lookup. Forwarded signatures are verified after
  advancing the clock beyond the former expiry window.
- SDK: production WASM rebuild, TypeScript build/typecheck, and 134 tests passed.

An additional client run enabling the restricted `expect_used` lint reports
three pre-existing calls in `ant-core/src/client_engine/files.rs`; this update
does not change that file. No live mixed-version fleet or rollback test was
run for this update.
