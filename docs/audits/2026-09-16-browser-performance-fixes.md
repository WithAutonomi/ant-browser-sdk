# Browser performance fixes — 16 September 2026

Related: [V2-803](https://linear.app/autonominetwork/issue/V2-803/investigate-webrtcwebtransport-support-for-browser-access-to-the).

## Changes

The browser adapter now retains immutable `VerifiedAddressRecord` objects in a
256-entry LRU cache, keyed by the complete hex-encoded signed publication.
Repeated FIND_NODE responses and wire/typed conversions reuse successful shared
saorsa-core verification. Changed signatures, keys, owners, sequences or addresses
require verification again. The per-instance cache never grants routing authority
by peer ID alone. Peer binding, fresh reliability metadata and shared monotonic
replacement/witness policy still apply; invalid entries are not cached.

The native WebRTC listener retains the authenticated STUN Binding request which
completes admission and queues it into the admitted generation's ICE connection
before starting the agent. ICE no longer waits for another retransmission to
answer or nominate. Return-path cookies, integrity checks, source binding,
resource limits and generation-aware cleanup remain in force.

No public SDK/native API, payment batching, routing/witness policy or wire format
changes are required. Both the SDK refresh and a node deployment containing the
transport fix are needed for the combined result.

## Revisions and artifacts

| Component | Tested revision |
| --- | --- |
| saorsa-transport | `6f0b1f623b487a222187e38d1e7fb25eb2f876cb` |
| saorsa-core | `0df7853ea24242694e91c67631986d6bea686199` |
| ant-protocol | `cdae7d19f004bbd384e9a6cc91f4df253b416044` |
| ant-node | `26f5fb79fbd82ff7dbe016ea46cd1afffaf5c442` |
| ant-client | `ffa23d8e83ba11f2bdc20ec5e4b079d7094faed7` |

The SDK TypeScript source is unchanged from `3d6d281`; this commit refreshes the
production WASM and generated bindings together. `src/wasm/source.json` records
a clean source checkout (`dirty: false`), release wasm32-unknown-unknown,
`browser-wasm` only and no default features.

WASM SHA-256: `75f535ab8ddceff265750ff49c4d7974ef79c63f80d3356f8436a16abba1e4f5`.

Baseline: SDK `3d6d281`, client `ddb4b712`, node `dd7e5240`, transport `7c77692d`.

## Measurements

Real Chromium, isolated localhost ant-devnet, disposable Anvil funds, random
incompressible input, actual single-mode batched payments and complete byte
comparison after every download. Native nodes use the repository dev profile
(opt-level 1); WASM uses the release build. Each comparison is one run with fresh
node identities and data, not a statistical distribution or a live-fleet result.

### Raw shared core: 64 MiB, 21 nodes, all nodes supplied as seeds

| Stage | Before | Fixed |
| --- | ---: | ---: |
| Preparation and quotes until payment callback | 9.491 s | 2.622 s |
| Complete paid upload | 14.166 s | 7.358 s |
| First fresh-reader download | 6.206 s | 2.654 s |
| Second fresh-reader download | 6.234 s | 2.661 s |
| Reused-reader download | 4.784 s | 2.514 s |

Preparation includes self-encryption and preflight; it is not a pure RPC quote
microbenchmark. Reused-reader downloads reuse connections, not whole-file bytes.
All three fixed downloads matched all 67,108,864 input bytes.

### SDK File path: 600,000,000 bytes, 20 nodes, one bootstrap

The production SDK uses its File worker, IndexedDB staging, default durable
checkpoint persistence and default download concurrency of three. Payments
remain batched: 64, 64 and 20 quotes. The download uses a fresh client.

| Stage | Before | Fixed |
| --- | ---: | ---: |
| Initial authenticated connection | 1.302 s | 0.162 s |
| Preparation and first payable batch | 35.964 s | 14.719 s |
| Complete paid upload | 98.165 s | 56.163 s |
| Fresh-client download | 45.553 s | 24.205 s |

The fixed upload completed in three paid batches; the download matched all
600,000,000 input bytes. Complete upload took 43% less time and download 47%
less time in this local run. The first payable batch arrived 59% sooner.
See [recorded events](2026-09-16-browser-performance-results.json).

## Validation

- Transport: 56 WebRTC tests pass, including an actual UDP/ICE test which sends
  no packet after the admission-completing Binding request and still receives
  the matching integrity-checked ICE success response. Existing tests cover
  invalid/unreturned cookies, source limits, stale generations and cleanup.
- Browser peer-record unit tests: 5 pass. Cache hits reuse the verified object;
  LRU eviction is bounded; tampering, malformed/oversized input and changed owner
  metadata are rejected; old cached sequences cannot replace newer publications.
- Generated WASM: 107 tests pass, including rejection of a tampered proof after
  the valid version was cached, routing, payment recovery and upload/download.
- Real Chromium integration: authentication, paid upload, recovery without
  another payment and download by public address pass against the pinned node.
- Transport all-target Clippy and client native/WASM Clippy pass with warnings
  denied. The final client also passes `cargo check -p ant-core --all-features`.
- SDK `npm run check`: build, type checks and 158 tests pass. All five examples
  build. `npm pack --dry-run --ignore-scripts` validates the package assets after
  the separately completed checks. Production exports contain no test/profiling
  hooks and no new public methods.

## Reproduction record

Commands were run in the corresponding web-support checkouts:

```sh
# saorsa-transport
cargo test --locked --features webrtc-direct --lib webrtc::
cargo clippy --locked --features webrtc-direct --all-targets -- -D warnings
# ant-node
cargo build --bin ant-devnet
# ant-client
cargo test --locked -p ant-core --lib browser::peer_records::tests
cargo clippy --locked -p ant-core --lib --tests -- -D warnings
cargo check --locked -p ant-core --all-features
cargo clippy --locked -p ant-core --target wasm32-unknown-unknown \
  --no-default-features --features browser-wasm --lib -- -D warnings
wasm-pack build ant-core --target web --out-dir wasm-tests/pkg --release \
  --no-default-features --features browser-wasm,test-utils
cd ant-core
node --import ./wasm-tests/setup-wasm.mjs --test ./wasm-tests/*.test.mjs
cd browser-tests
npm test
# SDK, after committing the Rust sources and dependency pins
npm run sync:wasm
npm run check
npm run build:examples
npm pack --dry-run --ignore-scripts
```

The investigation's temporary Playwright fixtures and raw logs are retained at
`/tmp/wasm-speed-history-20260916/`. `bench/sdk-harness.js` uses the actual built SDK
and `File`, and `bench/perf-harness.js` calls the raw Rust bindings. Both perform
actual Anvil payments and verify every downloaded byte. The SDK run command was:

```sh
cd /tmp/wasm-speed-history-20260916/bench
PERF_NODES=20 PERF_VARIANT=fixed PERF_BROWSER=chromium \
PERF_NODE_BIN=/tmp/wasm-speed-history-20260916/ant-devnet-fixed \
PERF_BYTES=600000000 node_modules/.bin/playwright test --config sdk.config.js
```

The fixtures use isolated ports 33000/34000/35000/35173 and clean up their own
processes/data. No existing app process or live testnet was changed. Temporary
node artifacts were copied after the final pinned build; the SDK bundle was
copied after its production rebuild, without experimental code.

These results establish the local Chromium improvements. They do not establish
Firefox/Safari performance, live-network capacity, or resolution of all reported
PUT/session/storage failures. Routing-table divergence was outside this task.
