# RPC deadline and authentication regression repair — 2026-09-16

The recent RPC regressions are fixed in the sibling `ant-client-web-support`
worktree and rebuilt into this SDK and the File Vault production assets. The
browser lookup grace policy remains unchanged: it predates the requested window.
NAT forwarding and endpoint publication were explicitly excluded by the user.
No deployed testnet was modified.

## History and scope

Dates below are author dates confirmed against the actual diffs. These commits
were rebased on September 14; their committer dates alone give the wrong history.

| Behavior | Origin | Outcome |
| --- | --- | --- |
| Outer operation-response timeout also charges peer queue and request transmission | September 8, `80d1bd5e78a445eddb126d73b4f3f973a97f245e` | Fixed |
| Strict authentication check after queueing rejects pooled work after its predecessor closes the association | September 14, `6160c90910effd065c634682fb92c69123c5f637` | Fixed while preserving strict explicit sessions |
| Five-second discovery grace measured from another peer's completion | August 31, `639f0fa98fb403797539b612e953ab0c5280c8be` | Outside the requested eight-day window; unchanged |
| Discovery timer switched to the shared constant | September 8, `cc648dd627bf823dd168b2580ddf21c1c1e03d43` | Both constants are five seconds; this did not introduce the behavior |

## Implementation

The private locked browser client owns HELLO, capability/payment-network
validation and the application exchange under one peer mutex. Pooled calls can
reauthenticate after an earlier failure. Explicit session handles check their
captured generation after acquiring that lock and cannot silently reconnect.

Pool/peer admission share one monotonic 400-second ceiling, allowing a maximum
request and response transfer plus setup without spending the remote response
allowance. Connection/PQ setup is bounded at 30 seconds and HELLO at 10 seconds.
Request transfer retains the existing size-based budget and high/low watermarks;
its final browser buffer drain is included. The caller's response timer starts
after that drain. Inbound timestamps keep buffered fragments from resetting the
response-frame deadline. An early invalid response retains its original error.

Queue expiry leaves active work alone. Abandoned encrypted requests retire their
association generation, including cancellation after sealing but before sending.
Pool closure prevents in-flight setup from publishing a new connection. Timeout
phase messages and timeout classification survive the browser data adapter.
Native wire behavior, payment proofs, and the four-peer quorum are unchanged.
The reasoning is recorded in the amended **Proposed** client ADR-0004.

## Source and artifact identity

- Client base: `ffa23d8e83ba11f2bdc20ec5e4b079d7094faed7`, plus the uncommitted repair.
- SDK base: `17b7759f49ed9891bbfdec58e60a817271a923cd`, plus generated artifacts and this audit.
- Node: `26f5fb79fbd82ff7dbe016ea46cd1afffaf5c442`, rebuilt with `cargo build --bin ant-devnet`.
- Node executable SHA-256: `8c29557cdcd3d3ac6f9f8cc713d71a6952349d4effc45b17d2b808b3ad083f28`.
- Production WASM SHA-256: `8896bcbc46ff3d31afb4d13160dffbf1c2c77cdcfa1c1da84630c1d3f37bab95`.

`src/wasm/source.json` intentionally records `dirty: true`: these are local review
artifacts, not a clean-source release. Bindings, WASM and provenance were generated
together by `npm run sync:wasm`. Regenerate from the committed clean source for a
release. The browser and File Vault asset hashes match this production binary.

## Validation

Four new regressions failed on the original artifact: queued calls lost their
response budget, blocked sends expired before transmission, queued work inherited
an unauthenticated association, and concurrent cold calls sent three HELLOs.
They pass with the repair. Additional regressions cover real transfer expiry,
final drain and early replies, queued/active cancellation, strict session handles,
pool closure during setup, bounded admission and capability checks after reconnect.

Commands and final outcomes:

| Check | Result |
| --- | --- |
| `cargo test -p ant-core --lib` | 696 passed |
| `wasm-pack build --target web --out-dir wasm-tests/pkg --release . --no-default-features --features browser-wasm,test-utils` (in `ant-core`) | Passed |
| `node --import ./wasm-tests/setup-wasm.mjs --test --test-concurrency=2 ./wasm-tests/*.test.mjs` | 119 passed |
| SDK `npm run sync:wasm` and `npm run check` | Build/typecheck passed; 158 tests passed |
| SDK `npm run build:examples` and `npm pack --dry-run` | All five examples and packaging passed |
| File Vault `npm run build` and `npm test` | Production build passed; 39 tests passed |
| `cargo fmt --all -- --check`, `git diff --check`, SDK ADR governance | Passed |

The first broad WASM run exposed four diagnostics failures when a malformed early
reply closed the channel during drain. Preserving the inbox's first error fixed
these; the final complete run passed. One app test run overlapped SDK regeneration
and could not resolve its temporarily removed `dist`; the sequential rerun passed.

The [reproducible Chromium driver](2026-09-16-rpc-browser-verification.mjs) uses
only owned local processes, a fresh twelve-node devnet and local Anvil funds:

```sh
node docs/audits/2026-09-16-rpc-browser-verification.mjs
```

The SDK's actual all-in-one demo connected, uploaded a random 1 MiB file, and
saved a byte-identical download. A second SDK operation uploaded 100 MiB of random
bytes (30 records, four replicas), ran concurrent discovery, and forcibly closed
one connected peer from that operation's pool after payment. It completed with
one payment-provider invocation; its download matched every byte. Concurrent
discovery returned twelve nodes and there were no browser page errors. Upload
plus download took 16.48 seconds on this local fixture; this is correctness
evidence, not a comparative performance benchmark. Responses served the exact
WASM hash listed above. See the [machine-readable result](2026-09-16-rpc-browser-results.json).

A preceding seven-node large-file attempt stopped before payment when discovery
returned six of the seven required witnesses. The twelve-node run passed without
changing lookup policy or weakening witness requirements. No constrained real
uplink or Safari run was performed; backpressure/deadline behavior was exercised
in the real Rust/WASM transport with mocked browser buffers. Remaining regional
discovery cancellations, NAT reachability, and unrelated node storage/payment
rejections are not resolved by this scoped repair.
