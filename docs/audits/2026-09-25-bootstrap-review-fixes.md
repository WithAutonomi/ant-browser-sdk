# Bootstrap review fixes — 2026-09-25

Addresses the three reproduced findings in [ant-client PR #206's review](https://github.com/WithAutonomi/ant-client/pull/206#pullrequestreview-5320201940).
This supersedes the bootstrap correctness claims in the earlier
[pooled-bootstrap audit](2026-09-25-pooled-bootstrap.md), while preserving its
historical timing results.

## Changes

- A later caller can retry an exhausted transient bootstrap batch with a
  one-second minimum interval between scheduled batch starts. Concurrent callers
  share that batch, at most four seed attempts run concurrently, and pool closure
  cancels delayed retries. The original expected payment identity stays fixed;
  permanent policy rejections and the existing failed-dial cache still apply.
- Cached readiness must correspond to a live authenticated pooled lane. Remote
  closure and LRU eviction require reconnection and fresh authentication before
  `connect()` reports success. Healthy repeated connections reuse their session.
- Control and data lanes validate seed HELLO policy before becoming usable.
  Rejection closes both lanes and remains visible to already-issued leases,
  queued admission, reconnect attempts and later requests. Either lane can
  discover the mismatch first; neither ordering permits a GET from the rejected
  seed. No wire, payment, integrity or public API rules are relaxed.
- Chromium CI now uses an explicit compatible browser-node revision instead of
  looking for a git `rev` on the native registry dependency. This fixes the
  reported setup failure independently of the transport changes.

## Provenance

- Core fixes: `f5f479b`; browser CI pin: `487f63f`.
- Production WASM source: `487f63f2b1d3e0b80e34d617eb5f8d7a1e3f6b57`, clean
  tracked checkout, as recorded in `src/wasm/source.json`.
- SDK TypeScript source: `8bb28e055a657aaef753f62dc943156bff01a8f1`, unchanged;
  this audit's containing commit replaces all five generated WASM/provenance
  files and updates Proposed ADR-0002.
- Node: `b0263b324c418a5732d1727d7a66df4c15946559`, clean checkout. This is also
  the new core `ant-core/browser-tests/node-revision` integration pin.
- WASM SHA-256: `7685faa491135a10549e4d90f21ed51832b137dd4254a8fa74a2c21c2e80c5d6`.
- Cargo.lock SHA-256: `99468f9bc974ce2187e94e0559f9ce1f089c0f897ff1ef8087db6a303421859a`.
- Tools: Node v22.23.1, Rust 1.96.1, wasm-pack 0.15.0.

## Validation

The new retry, remote-close and two concurrent rejection-order tests failed
against the previous WASM. The fixed generated-WASM suite also covers real LRU
eviction, unchanged healthy-session reuse, immutable trust after transient
failure and cancellation during retry backoff.

- `cargo fmt --all -- --check`, `git diff --check`, core and SDK ADR governance:
  passed. Both amended ADRs remain Proposed.
- `cargo clippy -p ant-core --target wasm32-unknown-unknown --no-default-features
  --features browser-wasm -- -D warnings`: passed, also with
  `browser-wasm,test-utils`.
- `wasm-pack build --target web --out-dir wasm-tests/pkg --release ant-core
  --no-default-features --features browser-wasm,test-utils`, followed by
  `node --import ./ant-core/wasm-tests/setup-wasm.mjs --test
  ./ant-core/wasm-tests/*.test.mjs`: **175 passed**.
- `cargo test -p ant-core --lib`: **727 passed**, including 128 shared-engine
  tests. The 128 also passed a targeted run and are a subset of the 727.
- `npm run sync:wasm` from the committed core, then SDK `npm run check`:
  build, types and **187 tests passed**, including the production WASM boundary.
- `npm run build:examples`: all five passed. `npm pack --dry-run`: passed.
- Real Chromium, production WASM, seven isolated WebRTC nodes and local Anvil:
  one payment, injected post-payment interruption, recovery without repayment,
  four replicas, and **12,800 matching downloaded bytes**. Closing the client
  prevents reconnecting. The SDK all-in-one demo separately uploaded, downloaded
  and saved **13,056 matching bytes**, with no page errors.

For the browser run, the production generated files were copied into the ignored
core harness package after the WASM suite completed. Started `node
start-devnet.mjs` and core Vite on 35173, and SDK all-in-one Vite on 35174, then
ran the retained `browser-check.mjs` probe. All task-owned servers were stopped.
The probe verifies local Anvil before using its publicly known development key.
Compressed commands/probe logs and SHA-256 checksums are in
[the evidence directory](2026-09-25-bootstrap-review-fixes/).

## Public-network startup smoke

Ran `node ant-core/browser-tests/sdk-startup.mjs
../ant-client-browser-sdk/dist 1 review-fixes 3` in a fresh Chromium context with
the rebuilt SDK, seven bundled seeds and default adaptive concurrency. File:
`134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889`.

| Milestone | After download starts | Including connection |
| --- | ---: | ---: |
| First content chunk (1/147) | 12.216 s | 14.310 s |
| Three content chunks (3/147) | 18.714 s | 20.807 s |

Connection took 2.094 seconds. Chunk 0/147 is progress initialization, not the
first downloaded chunk. This single smoke confirms that the repaired artifact
still starts a real download; it is not a controlled comparison or a full-file
benchmark. The previous full-file measurement remains historical.

## Limits

The reported macOS adaptive-controller CI failure passed locally without a
change to that test or algorithm. The previous failing CI run is not made green
by local results; new CI must run on the pushed commits. The browser setup fix
is validated by the production browser run against its exact pinned node, not
by claiming a completed remote CI run. A long-running uploader soak remains
outside this regression check.
