# WASM/native behavior audit — 2026-09-08

> Historical baseline: this audit describes ant-core `cd63ff3`. The SDK now
> bundles `9e906c9`, which uses the shared native Client and crate graph. Its GET
> integrity and PUT retry paths changed; the original probes below intentionally
> describe the old artifact. Receipt recovery and other SDK adapter behavior
> still require separate assessment. This is not a claim of full workflow parity.

**Conclusion at the audited baseline: WASM does not yet have full native ant-core/ant-client behavior.** Shared primitives and several policies are in place, but separate browser orchestration still changes discovery state, error handling, upload completion, payment recovery, scheduling, and cancellation. The preceding discovery-cache fix was correct; it did not establish complete parity.

This audit changes documentation only. The accompanying probes demonstrate current differences and are deliberately outside the normal regression suite.

## Scope and evidence

- Browser SDK baseline: `ca3c178`; ant-core baseline: `cd63ff3`.
- Native networking: the actual Cargo.lock dependency `saorsa-core a87ebd641627aaabd5f5aea7b0d1c002c9f03915`, including its lookup adapter, routing maintenance, address selection, and failure caches.
- Browser wire dependency: `saorsa-transport d2147379ae45ecccc28fb8313ec1d42efac407f6` / `saorsa-webrtc`.
- Reviewed native chunk/data/file APIs, CLI payment-mode defaults, shared engine modules, generated-WASM adapter source, SDK payment/recovery/lifetime handling, and Autonomi Web datamap import.
- Native APIs have different workflows themselves. Findings below identify whether the comparison is against chunk retrieval, in-memory data operations, external preparation/finalization, or the normal resumable file/CLI path.

Validation performed:

- 108 native `client_engine` tests passed.
- All 70 existing generated-WASM tests passed.
- SDK build, typecheck, and all 127 tests passed, including the payment-receipt/upload-recovery checks.
- Three isolated probes demonstrated integrity-error fallback, accumulation of PUT acknowledgements across retry rounds, and receipt reuse failing after a quote hash changes.

The first two probes use the real generated WASM, protocol framing and session cryptography with mocked browser RTC objects. The receipt probe exercises the built SDK helper with synthetic quote fixtures. Native expectations were established from the source paths cited below; this was not a paid native-versus-browser live-network comparison. No transactions were submitted. Passing the existing suites does not prove parity: one existing WASM test explicitly expects 40 GET attempts after corrupt responses, which native's fatal integrity-error handling would not allow.

## Confirmed behavior gaps

### 1. High priority: browser resume does not reuse native paid proofs by chunk address

WASM's `PreparedRecord` and payment proof are local to an upload invocation. SDK resume starts preparation again, obtains new quotes, and `paidReceipt` accepts an old receipt only when **every current quote hash** is covered by one retained payment. An issuer changing its signed timestamp changes that hash even when the chunk, price, and rewards address are unchanged. Multiple retained payments cannot jointly cover a plan under this single-transaction interface.

The native resumable file path retains serialized proofs keyed by chunk address. It prunes proofs locally by age, then reuses the original paid proof with newly discovered targets and pays only for chunks lacking usable proofs. It does not require a newly issued quote to have the original hash. Native also persists these proofs across process restarts; browser recovery exists only for the current page session.

**Impact:** browser recovery can request another payment covering an already-paid chunk. The SDK requires an explicitly supplied payment provider for a fresh recovery payment; this is not an automatic silent second charge. It is nevertheless a material difference from native cost/recovery behavior.

**Evidence:** the receipt probe accepts the original quote, then rejects receipt reuse for the same content and amount with a changed quote hash.

Sources: [SDK resume and payment callback](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/client.ts:310), [receipt matching](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/internal/upload-recovery.ts:210), [native cached proof reuse](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:649), [native local proof-age validation](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:1062).

### 2. GET error classification is different despite the shared retry engine

WASM passes `|_| true` into the shared chunk-retrieval engine and the full-file/range deferred-fetch helpers. Its GET errors are strings, so integrity failures, wrong-address responses, transport failures, and remote failures all permit another peer attempt. Its fetch observer also classifies every final error as a timeout.

Native `chunk_get_from_peer` returns `InvalidData` for a wrong address or BLAKE3 mismatch. Native chunk retrieval only continues for `Timeout`, `Network`, or `Protocol` errors. Native in-memory data/range fetching has an explicit retryable-error list excluding invalid data, and the native fetch observer distinguishes network, timeout, and application failures.

**Impact:** different success/failure outcomes, unnecessary retries, and different concurrency feedback. Integrity verification remains enforced: WASM does not return corrupt bytes, but it can hide an integrity failure by succeeding from another replica where native chunk/data retrieval would stop. Native filesystem download has its own outer deferral of chunk-fetch errors; that does not make the inner peer-sweep behavior equivalent.

**Evidence:** a corrupt first replica followed by a valid replica produces a successful WASM open after two GETs. Native's chunk-get classifier would return the first integrity error.

Sources: [WASM GET classification](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:1030), [WASM retry predicate](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:1121), [native retrieval predicate](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/chunk.rs:580), [native integrity errors](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/chunk.rs:718), [native deferred-fetch predicate](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/data.rs:508).

### 3. PUT retry rounds use different completion criteria

WASM retains `successful_peers` after a failed attempt. The next attempt requests only `4 - previous_successes` acknowledgements and excludes those previous peers.

Native retries the paid chunk by calling `chunk_put_to_close_group` again. Each call starts from the ordered targets and requests four acknowledgements. Partial successes from an earlier failed call are not carried into its quorum counter.

**Impact:** WASM can report upload completion when no individual attempt satisfies native's four-acknowledgement requirement. This is a semantic change, even if accumulating acknowledgements could be a reasonable optimization in another design.

**Evidence:** the probe permits three peers in the first attempt, then only a fourth peer in the next attempt. WASM reports four replicas and success for every record; native's second call would have only one successful peer.

Sources: [WASM retained successes](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2409), [WASM reduced retry quorum](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2467), [native fresh quorum](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/chunk.rs:331), [native retry call](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:890).

### 4. Routing state and endpoint selection are still custom browser policy

Sharing `run_iterative_lookup` does not share the surrounding routing policy:

- WASM merges endpoint reports with `HashMap::insert`; a later third-party report can overwrite an earlier endpoint for a peer. Native collects reports per subject and selects a winner using self-report precedence, publish sequence, responder agreement, and XOR-distance fallback, then refreshes final lookup results from those winners.
- Browser wire `BrowserNode` contains one WebRTC endpoint plus diagnostic native addresses/reliability. It omits native publish-sequence and address-type data needed to reproduce the native winner rules. Certificate/peer-ID validation authenticates the endpoint being contacted, but does not choose between stale and current endpoint reports for the same peer.
- WASM retains a flat routing map, trimmed to 256 peers nearest the most recent lookup target. Native uses its Kademlia routing table and periodic maintenance. WASM consults seed HELLOs only when the routing map is empty; it has no equivalent background routing refresh.
- Native coordinates concurrent peer dials and broadcasts active FIND_NODE failures to other in-flight lookups. WASM has a connection pool and per-connection request mutex, but no corresponding lookup-failure bus.
- The newly fixed failure cache is still a WASM-only implementation despite residing in `client_engine`: one failure entry per peer/exact endpoint, a 256-entry limit, and eviction when a different endpoint is checked. Native tracks failed socket addresses, including transport-specific relay/IP suppression and authenticated-publish exceptions. Those native QUIC/relay details cannot be copied blindly to WebRTC, but the policies are not identical.

**Impact:** stale endpoint reports and repeated operations can evolve browser peer eligibility differently from native. These are source-confirmed gaps; the audit did not reproduce a live stale-endpoint failure or establish that they caused the user's original incident.

Sources: [WASM routing initialization](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:949), [routing trimming](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:1000), [endpoint overwrite](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:1253), [browser failure cache](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/client_engine.rs:213), [native report winner](/Users/mick/.cargo/git/checkouts/saorsa-core-052b84e110284f53/a87ebd6/src/dht_network_manager.rs:1571), [native lookup adapter](/Users/mick/.cargo/git/checkouts/saorsa-core-052b84e110284f53/a87ebd6/src/dht_network_manager.rs:1820), [native maintenance](/Users/mick/.cargo/git/checkouts/saorsa-core-052b84e110284f53/a87ebd6/src/dht_network_manager.rs:2276).

### 5. Quote scheduling does not use the native adaptive quote channel

WASM prepares the first record alone, then prepares the remaining records at a hard-coded concurrency of four. It never feeds those preparations into `controller.quote`. Native batch and externally prepared data uploads use the quote controller's current cap, observe each preparation, and can adapt subsequent scheduling. Native defaults start quote concurrency at 32, with a configurable ceiling of 128.

**Impact:** browser quote preparation has different load, latency, and adaptation behavior. Putting the bounded scheduler in a shared module did not share the scheduling decisions at its call sites.

Sources: [WASM preparation driver](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2014), [native wave quoting](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:765), [native external preparation](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/data.rs:307).

### 6. Large-file upload/payment workflows are not shared

WASM prepares the entire file, requests one payment transaction hash, and then stores all records. The stock Wagmi/Ethers providers submit the full quote list in one call.

Native's normal single-payment-mode upload driver deduplicates chunk addresses and uses 64-chunk payment waves with overlapping preparation/storage. Native payment finalization accepts transaction hashes mapped to quotes. The normal file/CLI default is `Auto`, with Merkle payments available at the default threshold of 64 chunks. Browser APIs/wire PUTs have no corresponding Merkle proof path and carry only the selected issuer's quote, whereas native single-node proofs retain their selected quote set.

**Impact:** different transaction sizing, gas behavior, large-upload scheduling, and recovery granularity. Actual transaction-limit failures were not tested. The native in-memory external prepare API also prepares all chunks before signing, so all-file preparation alone is not a deviation from every native API; lack of native modes and per-proof finalization is the broader gap.

Sources: [WASM payment/store boundary](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2053), [native waves and deduplication](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:539), [native transaction mapping](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/batch.rs:424), [native file default](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/file.rs:1183), [native Merkle threshold](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/merkle.rs:473).

### 7. Read discovery width, caches, and concurrency differ

- WASM asks for 20 primary GET peers. Native chunk reads default to the configured close-group size of seven. Both then use the shared additional-known-peer fallback bound of 20; sharing that bound does not make the primary candidate sets identical.
- Native has a client-wide verified chunk cache, default capacity 1,024 chunks. WASM has a 32 MiB cache owned by each range reader; ordinary full downloads and public-datamap opens do not use an equivalent shared cache.
- SDK full downloads default to concurrency three and reject values above six; WASM also clamps fetch/range concurrency to six. Native's adaptive fetch controller starts at four and can grow to its configured ceiling, default 256. WASM constructs default controllers per client without native's persisted warm-start behavior.

**Impact:** repeated opens/downloads and simultaneous operations cause different network traffic and performance. Browser memory limits can be justified, but they are explicit platform policy and must not be described as identical native behavior.

Sources: [WASM defaults](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:56), [SDK limits](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/limits.ts:6), [native cache and GET](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/chunk.rs:532), [native controller setup](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/mod.rs:285).

### 8. Deadlines and request scheduling differ

Native quote collection has a 120-second overall deadline and configurable per-peer timeout. WASM's quote collection loop has no equivalent overall deadline. Pool/connection-mutex waits are outside the per-RPC transfer timeout.

WASM serializes all RPCs on a connection through one mutex. A long GET/PUT can hold up a FIND_NODE on that connection. Transport transfer deadlines are calculated by the shared WebRTC wire profile from frame size (10-second base, up to 180 seconds), rather than native's default 10-second GET/single PUT response deadlines. Browser deadline bookkeeping uses `Date::now`, whereas native timers use monotonic runtime clocks.

**Impact:** contention and failures can take different lengths of time and interact differently with the otherwise shared five-second lookup grace period. The size-dependent frame budget belongs to transport; absence of a native operation deadline and use of wall-clock time should be reviewed separately.

Sources: [native quote deadlines](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/data/client/quote.rs:925), [WASM request serialization](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:547), [WASM quote loop](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2208), [WASM response deadline](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2843).

### 9. SDK operation cancellation does not cancel the WASM workflow

`abortable` stops waiting for a Promise. Lookup/download/range calls generally supply no cancellation callback to the core. A cancelled SDK call can therefore leave the WASM workflow running, consuming pooled connections or performing retries. Uploads deliberately retain settlement observation; after payment, already-running buffered upload work can continue as well. Closing the whole client shuts down the pool, but that is different from cancelling one operation.

Native async workflow futures can be dropped with their in-flight Rust work. The WASM transport has cancellation cleanup when a Rust future is actually dropped, but an `AbortSignal` racing the JavaScript Promise does not cause that drop.

**Impact:** activity from an operation the UI reports as cancelled can contend with the next upload. This was source-reviewed; no live cancellation/contention incident was reproduced. Receipt observation must still survive cancellation of cancellable network work.

Sources: [SDK Promise cancellation](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/internal/abort.ts:23), [download call](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/client.ts:414), [range call](/Users/mick/RustroverProjects/ant-client-browser-sdk/src/file-reader.ts:56), [WASM request cleanup](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:464).

## Capability and adapter differences to keep explicit

| Area | Current browser behavior | Native comparison / implication |
| --- | --- | --- |
| Local/private datamaps | Public address or SDK public-file descriptor; app imports SDK JSON or text addresses | Native accepts actual MessagePack/legacy JSON datamaps and private uploads. WASM still fetches the public map by address; native private datamaps are unsupported. |
| File/range sizes | 1,000,000,000-byte file limit; 4 MiB individual range limit | Additional browser restrictions, not self-encryption/native data API requirements. |
| Transport | WebRTC/DTLS/PQ, one browser endpoint per peer, capability and payment-network admission | QUIC, typed multiple addresses, relay paths. Socket/JS APIs must remain adapters, but routing decisions need shared inputs/policy. A mixed network with native-only peers cannot offer identical reachable peer sets. |
| Proof wire shape | Selected issuer quote and one transaction hash | Native proof bytes/sidecars and per-quote transaction mapping. Supporting native recovery/Merkle requires extending this boundary. |
| Staging | Record metadata prepared before payment; loader bytes verified when storing | Native `prepare_chunk_payment` computes the address from available content. Missing/corrupted browser staged data can be discovered after payment. This is a staging/lifetime boundary to address in a shared prepared-upload design, not a demonstrated normal-upload failure. |
| Low-level lookup API | Exported `BrowserIterativeLookup` accepts custom alpha/max-iterations and a JS batch callback | Uses the shared algorithm but is not the native-configured high-level client. It is not used by `AutonomiClient`'s normal network path. |
| Browser media/files | Worker staging, IndexedDB, Blob/ReadableStream, service-worker HTTP ranges, MIME/name descriptors | Appropriate browser I/O adapters; core datamap resolution and range arithmetic can remain shared. |

Sources: [app datamap rejection](/Users/mick/RustroverProjects/ant-file-vault/src/files.ts:79), [native datamap reader](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/datamap_file.rs:134), [WASM public-map fetch](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:1808), [WASM staged loader](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser/wasm_transport.rs:2464), [low-level lookup configuration](/Users/mick/RustroverProjects/ant-client-web-support/ant-core/src/browser.rs:364).

## Verified shared behavior

The existing work does share meaningful policy. Both main paths use the same iterative lookup engine; upload discovery requests 20 initial peers and falls back to seven; initial/witness requirements, witness voting, quote selection, upper median, 3× payment, existing-holder voting, and PUT target ordering call shared helpers. Record verification, native self-encryption, recursive datamap resolution, range calculations, and decryption are shared. Store retry count/backoff and source-byte budget are shared. The discovery-cache correction properly stopped failed/grace-cancelled FIND_NODE requests from creating dial failures.

These statements describe the shared functions, not equivalence of all their callers. The differences above are precisely why helper-level tests alone were insufficient.

## Suggested implementation boundaries

1. Share typed GET errors and retry/outcome classification, including matching primary discovery width. Convert the integrity probe into a cross-adapter parity regression.
2. Move paid-record retry state and completion policy into one shared store driver; remove browser accumulation unless native is intentionally changed too.
3. Share prepared/paid upload state, per-chunk proof reuse/age checks, and per-proof transaction mapping. Adapt durable storage to the browser instead of inventing a second recovery policy.
4. Share quote operation deadlines, quote-controller observation, and upload wave/mode selection. Keep transport byte budgets configurable at the adapter boundary.
5. Extract portable native routing/report-selection policy and expose enough authenticated endpoint metadata to apply it in WASM. Reuse native lifecycle/failure coordination where transport semantics permit.
6. Add core operation cancellation and native datamap inputs. Keep payment settlement observers alive independently from cancelled network work.

No fresh-discovery bypass, relaxed witness threshold, or browser-only recovery heuristic is needed to address these findings. The goal should be one state machine per workflow with transport/storage/wallet/timer adapters, plus paired native/WASM tests at those adapter boundaries.

## Reproduce the audit probes

With the sibling repositories arranged as in this workspace, build the core test artifact if absent:

```sh
cd ../ant-client-web-support
wasm-pack build --target web --out-dir wasm-tests/pkg --release ant-core --no-default-features --features browser-wasm,test-utils
cd ../ant-client-browser-sdk
npm run build
node --import ../ant-client-web-support/ant-core/wasm-tests/setup-wasm.mjs docs/audits/wasm-native-parity-probes.mjs
```

The probes assert the audited behavior at the stated commits. They should cease passing as the gaps are fixed; they are not a specification of desired behavior. The test-utils artifact is separate from the production SDK WASM.
