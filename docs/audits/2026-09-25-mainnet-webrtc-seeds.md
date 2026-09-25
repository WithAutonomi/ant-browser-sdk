# Bundled mainnet WebRTC seeds — 2026-09-25

The supplied seven complete WebRTC Direct addresses are now bundled in the
shared client's `ant-core/resources/bootstrap_peers.toml`. The existing
`getNetworkDefaults()` and default `AutonomiClient.connect()` paths consume them
without TypeScript endpoint constants or a new connection policy. Explicit
addresses and custom network profiles retain their existing behavior.

## Commits and artifact

The preceding startup fixes and this configuration change were committed
separately in each repository:

- Core startup fix: `96d63f9fe400efc4ce196a63c46e4c5a03875ac7`.
- SDK startup artifact: `32e3c2d`, regenerated from that clean core source with
  WASM SHA-256 `b47583c875157c7039ccf2ca91517fbd25977c91ecf2cb6ecf6fdbef11f03701`.
  The earlier [startup audit](2026-09-25-read-startup.md) remains a historical
  record of the investigation build.
- Core bootstrap addresses: `6396669c97db67fe54304830e4d4a49d4974445e`.
- This SDK artifact was generated with `npm run sync:wasm` from that clean core
  commit; `source.json` records `dirty: false`, no default features and only
  `browser-wasm` enabled.
- WASM SHA-256:
  `6bac53390f8709cf2f824933aa0420c930994328e6a80e7ccfc1b69b21f3f417`.
- Cargo.lock SHA-256:
  `99468f9bc974ce2187e94e0559f9ce1f089c0f897ff1ef8087db6a303421859a`.

No wire, storage or public API format changed. Native QUIC seeds were not edited.
The README and all-in-one demo now describe the available bundled defaults.

## Validation

- Exact comparison of the shared WebRTC list with all seven supplied addresses:
  passed, preserving order, certificates and peer pins.
- `cargo test -p ant-core --lib network_defaults`: five tests passed, including
  transport separation, duplicate/invalid seed rejection and shared EVM identity.
- `npm run check`: build, types and 185 tests passed, including the actual
  packaged WASM defaults and artifact provenance checks.
- `npm run build:examples`: all five passed.
- `npm pack --dry-run`: passed; nothing was published.
- SDK ADR governance passed.
- Real Chromium checked that `getNetworkDefaults().seeds` exactly equals the
  supplied list. It authenticated each seed with the bundled expected mainnet
  payment identity: **7/7 passed**.
- The same browser then called `AutonomiClient.connect()` using the default
  mainnet profile and downloaded the first three content chunks of
  `134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889`.
  First chunk: 29.737 seconds; third: 31.940 seconds, measured from the start of
  default connection including its authentication probe. This is a functional
  live sample, not a performance comparison. The page was intentionally closed
  after the third chunk.
- A separate Chromium request to the default RPC from the File Vault origin
  successfully returned Arbitrum One chain ID `0xa4b1`. The download itself
  required no wallet or payment RPC.
- File Vault `npm run build` passed; the resulting WASM asset matches the hash
  above. The SDK import and public-network probe used its existing local Vite
  server in an isolated browser context.
- The all-in-one SDK demo was also exercised against seven isolated local nodes
  and Anvil using an explicit devnet endpoint. It paid for four records,
  uploaded and saved 13,056 matching bytes with no page errors. Node revision:
  `b0263b324c418a5732d1727d7a66df4c15946559`. The core browser-tests
  `start-devnet.mjs`, SDK Vite example on port 35174 and the prior investigation's
  Chromium demo probe were used; task-owned processes were stopped afterward.

Per-seed authentication and default-read progress are retained in
[the JSONL log](2026-09-25-mainnet-webrtc-seeds.jsonl). These results establish
availability at the time of testing, not future certificate or node uptime.
The full large file was not downloaded in this startup check.
