# Single production networking client — 2026-09-25

The bundled production WASM no longer exports `BrowserNodeClient` or
`BrowserNodeSession`. `BrowserNetworkClient` owns bootstrap authentication,
discovery and transfers, retaining the authenticated connections in its pool.
The high-level SDK API is unchanged. Direct consumers of the removed low-level
exports must migrate; this is an intentional breaking WASM API change.

Potential uses of a standalone client were considered: single-node health and
identity checks, exact-replica inspection, and protocol diagnostics. The first
works through a one-seed network client. No current production SDK or File Vault
caller needs the latter two. Internal per-peer connections remain necessary and
are retained. A future diagnostic API would need its own explicit requirements.

The existing framing, address-proof, deadline and generation-closure regressions
now use `test_connect_node()` and a limited `TestNodeSession`, compiled only with
`test-utils`. Unused public quote/PUT wrappers and their return types were deleted;
legacy per-node record helpers needed by transport tests are also test-only.
The real-browser harness authenticates and uploads through the same production
network client. A packaged-boundary test checks both JavaScript and binary WASM
exports for the absence of the former clients and test seams.

This follows the [pooled-bootstrap audit](2026-09-25-pooled-bootstrap.md), whose
statement that standalone clients remained available describes the earlier
artifact. Its timing measurements are historical; this API cleanup was not
benchmarked for an additional startup improvement. Proposed core ADR-0004 and
SDK ADR-0002 and the public README now describe the single-client boundary.

## Provenance

- Core base: `6396669c97db67fe54304830e4d4a49d4974445e`, plus working-tree changes.
- SDK base: `f9ff6d70817b711e85f92e1591a2cb7c6f033171`, plus working-tree changes.
- Node: `b0263b324c418a5732d1727d7a66df4c15946559` (clean checkout).
- Production WASM SHA-256:
  `e7d4028238782b79776db6c101be43247ebca94f071309692010bdcf5c9bfe6b`.
- Cargo.lock SHA-256:
  `99468f9bc974ce2187e94e0559f9ce1f089c0f897ff1ef8087db6a303421859a`.

`npm run sync:wasm` regenerated bindings, binary and provenance together.
`source.json` records `dirty: true`, `wasm32-unknown-unknown`, no default features,
and only `browser-wasm`. A clean source rebuild remains required for release.
Changed core source fingerprints, compressed check logs and the exact local
browser probes are retained in [the evidence directory](2026-09-25-single-network-client/).

## Validation

- `cargo clippy -p ant-core --target wasm32-unknown-unknown
  --no-default-features --features browser-wasm -- -D warnings`: passed, also
  with `browser-wasm,test-utils`.
- `wasm-pack build --target web --out-dir wasm-tests/pkg --release ant-core
  --no-default-features --features browser-wasm,test-utils`, followed by
  `node --import ./ant-core/wasm-tests/setup-wasm.mjs
  --test ./ant-core/wasm-tests/*.test.mjs`: **169 passed**.
- SDK `npm run check`: build, types and **187 tests passed**.
- SDK `npm run build:examples`: all five passed; `npm pack --dry-run`: passed.
- Production generated SDK assets were copied into the ignored core harness
  package after the generated-WASM suite finished. Chromium exercised
  `runIntegration()` against seven isolated WebRTC nodes and local Anvil:
  authenticated HELLO, one payment, injected post-payment interruption, recovery
  on a new client without another payment, four replicas and **12,800 matching
  downloaded bytes**. The closed network client rejected reconnection.
- Chromium drove the SDK all-in-one demo against the same devnet: paid upload,
  download and save of **13,056 matching bytes**, with no page errors.
- The first combined browser attempt passed core integration, then failed to
  resolve the SDK import while File Vault's prebuild recreated SDK `dist/`.
  After the build completed, the isolated SDK Vite server was restarted and the
  SDK probe passed. Both attempts are retained; no runtime code change was needed.
- File Vault `npm run build` and `npm test`: passed, **44 tests**. Its built WASM
  checksum matches the production artifact above. No app source was changed.
- Core rustfmt, core/SDK whitespace checks and both ADR governance checks passed.

The browser runs used local ports 35000, 35173 and 35174 and a temporary devnet
data directory. All task-owned test servers and nodes were stopped afterwards.
No public-network writes, publication or commits were performed for this cleanup.
