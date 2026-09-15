# Bootstrap multiaddresses and network defaults — 2026-09-15

## Scope and source provenance

This validates the foundation described in [Proposed ADR-0002](../adr/ADR-0002-browser-network-defaults.md).
Mainnet WebRTC seeds remain deliberately empty. No live mainnet connectivity
or public RPC availability is claimed.

- SDK base revision: `e06b8d2136b62cea270a57140190eb2bcdaac264`, plus this
  working-tree change.
- Shared ant-client base revision: `2b0aa662ba54f1c0b2b263251c6bda8a88e08ba2`,
  plus the companion network-defaults changes in `../ant-client-web-support`.
  The complete Git tree for those changes is
  `a4ed23203c75311d81cdb8b6ae8b1dfde16c25db` (excluding the pre-existing untracked
  `.idea` directory; computed with a temporary index without staging user files).
- Node checkout: clean `4c1509ddfaf1d626594c63d791a3a63dfee3e102`.
  Existing `ant-devnet` binary SHA-256:
  `336c01d2e9f25d9f70a99caeb553a7b91c509e0896acd6ab4c82d2a5d3134048`.
- evmlib: `cf424c0447c9f1ca1313b43ce07df65a227e340c`;
  ant-protocol: `d557f5e1a6c9c67cc12615299c54b291423340c3`;
  saorsa-core: `dc00a2c1a653d6b20666d0b3d89ba8a17b86ff96`;
  saorsa-transport: `bc6dcd80aa26ea6a4a557c05dd1af1ff2adf279f`.
- WASM SHA-256:
  `f2c983f3602e3b545ce6e7315924c6bbec63e644f9ef76399a386952d3777bd1`.
  The final `src/wasm` and built `dist/wasm` binaries matched this hash.
- Cargo.lock SHA-256:
  `cad766f3642579804f3f07cd7278037f5136c28323abd472189681077bacc2a7`.

Initial validation used a development build from uncommitted shared Rust changes;
at that point `src/wasm/source.json` recorded `dirty: true`.

### Clean source rebuild before commit and push

The shared changes were subsequently committed and pushed on `web-support` as
`0e7fd7cc3ed3a3809f83d8dbfeba567be43476d9`. Its tree matches the validated tree
above. `npm run sync:wasm` rebuilt the SDK artifact from that revision, with
`dirty: false`. The WASM SHA-256 is unchanged, so the real-browser results below
apply to the committed binary. Generated bindings, binary, and updated
provenance are included together in the SDK commit.

## Behavior covered

- One shared packaged TOML resource contains separate QUIC and WebRTC
  multiaddress arrays. Legacy installed socket-address files remain readable.
- Native CLI/core APIs preserve QUIC peer identity suffixes. WASM exports only
  WebRTC seeds, payment identity, and the shared evmlib RPC default.
- `getNetworkDefaults()` works with an empty seed list. Default connections
  report `CONNECTION_FAILED` before dialing; no QUIC or EVM RPC fallback occurs.
- Custom profiles validate all seeds before dialing, retain payment identity
  checks, fail over within the profile, and remain separate from mainnet.
- The all-in-one demo uses mainnet defaults when its bootstrap field is empty.

## Automated validation

All final commands passed:

```text
# Shared ant-client checkout
cargo test -p ant-core --lib network_defaults
cargo test -p ant-core --lib config::tests::
cargo test -p ant-cli bootstrap_tests
cargo check -p ant-cli --tests
cargo fmt --all -- --check
cargo clippy -p ant-core --lib -- -D warnings
cargo clippy -p ant-core --target wasm32-unknown-unknown --no-default-features --features browser-wasm -- -D warnings
cargo package -p ant-core --list --allow-dirty
python3 scripts/adr-governance.py

# Browser SDK (build and pack commands executed sequentially)
npm run sync:wasm
npm run check
npm pack --dry-run
npm run build:examples
python3 scripts/adr-governance.py
git diff --check
```

The final prepack check built the SDK, typechecked it, and passed **158 tests**
across 19 files. The five example production builds passed. Package inspection
confirmed both licenses, WASM, worker assets, and provenance. Rust package
inspection confirmed `resources/bootstrap_peers.toml` and
`src/network_defaults.rs` are included. Rust tests cover transport separation,
duplicate/malformed seeds, legacy sockets, preserved QUIC pins, CLI parsing,
and authoritative manifest selection. Native and WASM Clippy passed after
simplifying one boolean expression identified by Clippy.

Portable TOML parsing uses an existing dependency but increases the WASM binary
from 4,487,793 to 4,853,686 bytes (365,893 bytes). No new npm dependency was added.

## Real-browser demo

Used Chromium **151.0.7922.34**, an isolated eight-node devnet with local Anvil,
and Vite on port 39052. The manifest server used port 39051; QUIC/WebRTC ports
were allocated by the devnet. Only task-owned processes were stopped.

```text
ant-devnet --nodes 8 --bootstrap-count 3 --base-port 0 \
  --webrtc-direct --webrtc-direct-base-port 0 --enable-evm \
  --manifest /private/tmp/network-defaults-vcbvbbi4/manifest.json \
  --data-dir /private/tmp/network-defaults-vcbvbbi4/nodes \
  --serve-port 39051 --stabilization-timeout-secs 90
npx vite --config examples/all-in-one/vite.config.ts \
  --host 127.0.0.1 --port 39052 --strictPort
node /private/tmp/network-defaults-vcbvbbi4/browser.mjs
```

The Playwright probe exercised the real all-in-one UI and final built SDK:

1. Empty bootstrap field reported missing mainnet WebRTC seeds.
2. An explicit devnet WebRTC multiaddress authenticated successfully.
3. A 3,800-byte `File` uploaded through the demo's worker/IndexedDB path with
   actual local-Anvil payment using the devnet's disposable wallet.
4. A custom profile connected and downloaded the file byte-for-byte.
5. Applying mainnet payment identity to a devnet seed rejected with
   `NETWORK_MISMATCH`.

The first attempted devnet command included `--public-file`, which this binary
rejects without `test-utils`. The successful run omitted prepaid seeding and
performed an actual paid upload instead. The final browser run passed against
the final packaged WASM hash above. Logs and the local probe are under
`/private/tmp/network-defaults-vcbvbbi4`; no wallet key is included in this audit.

## Limits

No production WebRTC endpoints are configured, and mainnet/public RPC CORS,
certificate rotation, Firefox/Safari, and native QUIC end-to-end connectivity
were not validated here. Payment adapter provider-selection behavior is
unchanged: applications can pass `(await getNetworkDefaults()).rpcUrl` when creating
providers, while injected wallets continue to use their own providers.
