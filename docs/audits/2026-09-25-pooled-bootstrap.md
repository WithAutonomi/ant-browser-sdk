# Pooled bootstrap startup — 2026-09-25

The SDK now constructs a single `BrowserNetworkClient` and authenticates through
its pool. It no longer opens and discards a standalone node client. The Rust
network client admits up to four bootstrap attempts concurrently and returns
the first seed passing authentication, capability and expected-network checks.
Other attempts continue in the same pool, and discovery starts before every
seed has finished. The SDK's public connection overloads are unchanged.

Core base: `6396669c97db67fe54304830e4d4a49d4974445e`; SDK base: `f9ff6d7`.
Both include the accompanying working-tree changes. `npm run sync:wasm`
regenerated bindings, binary and provenance together; `source.json` records
`dirty: true`, target `wasm32-unknown-unknown`, no default features, and only
`browser-wasm`. Production WASM SHA-256:
`bec8ca3b33e0f74de1e24df49f47d71189a16012117243f7f77f0e392006b23c`.
Cargo.lock SHA-256:
`99468f9bc974ce2187e94e0559f9ce1f089c0f897ff1ef8087db6a303421859a`.

The amended Proposed SDK ADR-0002 and core ADR-0004 describe retained connection
ownership, bounded seed selection, immutable bootstrap trust and cancellation.
The low-level standalone WASM node client remains available. The shared native
lookup engine, read scheduler, quorum policy and verification were not changed.

## Live measurements

Fresh Chromium contexts downloaded the first three chunks of
`134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889` using the
default seven-seed profile. Three baseline/changed pairs were alternated. Median
first-chunk time including connection was **28.5 s before / 18.6 s after**;
download-only time was **23.2 s before / 16.5 s after**. Median connection time
fell from **5.27 s to 2.11 s**. These are small live samples, not guarantees.

The reproducible SDK startup probe, exact milestones, source fingerprints,
compressed raw traces and check logs are in the sibling core checkout's
[pooled-bootstrap investigation](../../../ant-client-web-support/docs/investigations/2026-09-25-pooled-bootstrap/README.md).
The probe serves a selected SDK `dist` directory locally and needs no wallet.

## Checks

- `npm run check`: build, types and 186 tests passed, including cancellation
  cleanup and preservation of one network client across authentication/read.
- `npm run build:examples`: all five passed.
- `npm pack --dry-run`: passed; no package published.
- SDK and core ADR governance, rustfmt and whitespace checks passed.
- Core generated WASM: 169 passed. Tests cover first-ready discovery, connection
  reuse, delayed-seed fallback, the four-attempt bound, closure, trust-policy
  immutability and rejection of a fast wrong-network seed.
- Shared Rust engine: 128 passed; native and WASM Clippy with warnings denied
  passed. Existing upload lookup-count and quorum regressions passed.
- Real Chromium drove this SDK's all-in-one demo against seven isolated nodes
  and Anvil, paying for four records, uploading and saving 13,056 matching bytes
  with no page errors. Node revision:
  `b0263b324c418a5732d1727d7a66df4c15946559`. The core browser-tests
  `start-devnet.mjs` and SDK example on port 35174 were used with the retained
  demo probe; only task-owned processes were started and stopped.
- File Vault's build and 44 tests passed; its built WASM checksum matches this
  SDK. Its existing explicit single-seed setting benefits from connection reuse;
  the all-seven benchmark uses the SDK default profile.

The public-file probes stop after three content chunks. Whole-file correctness
is separately covered by the tests and local browser upload/download. No full
147-chunk throughput or reconstruction-time improvement is claimed.
