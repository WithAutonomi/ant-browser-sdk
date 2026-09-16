# RPC repair: clean-source publication — 16 September 2026

Related: [V2-803](https://linear.app/autonominetwork/issue/V2-803/investigate-webrtcwebtransport-support-for-browser-access-to-the).

The RPC deadline and session-recovery changes documented in the
[repair audit](2026-09-16-rpc-deadline-repair.md) are committed and pushed as
client `f1303e1ad7bab49c8dc12af030ba71ec5fca0237`. The earlier audit and its browser result JSON
remain historical records of the review build before that commit.

This SDK refresh rebuilds the production bindings and WASM from the clean client
checkout (`dirty: false`) and records the committed revision in
`src/wasm/source.json`. Production WASM SHA-256:

`8896bcbc46ff3d31afb4d13160dffbf1c2c77cdcfa1c1da84630c1d3f37bab95`

The binary is byte-identical to the artifact in the earlier
[browser verification](2026-09-16-rpc-browser-results.json). That run verified the
actual SDK demo and a 100 MiB upload/download with concurrent discovery, a forced
connection closure, one payment invocation and matching downloaded bytes. The
browser run was not repeated for this metadata-only artifact publication.

Fresh checks during publication:

- `cargo fmt --all -- --check` and `git diff --check`: passed.
- `cargo clippy --locked -p ant-core --target wasm32-unknown-unknown --no-default-features --features browser-wasm --lib -- -D warnings`: passed.
- `cargo check --locked -p ant-core --all-features`: passed.
- Release WASM with `browser-wasm,test-utils` rebuilt; all 119 generated-WASM tests
  passed with `--test-concurrency=2`, including the new RPC deadline regressions.
- SDK `npm run sync:wasm`, `npm run check`: passed; 158 tests passed.
- `npm run build:examples`: all five examples passed.
- `npm pack --dry-run --ignore-scripts`: passed after the separate checks.

Core, protocol, transport and node dependency revisions are unchanged and their
web-support branches were verified against origin. This client change has no
new upstream dependency requirement. The SDK artifact is its downstream update.
No deployed testnet was changed; unrelated local files were left untouched.
