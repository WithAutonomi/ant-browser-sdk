# Contributing

Use Node.js 20.19 or newer and run `npm run check` before submitting a change.
Public APIs must remain typed, browser capabilities must be feature-detected, and
untrusted protocol data must continue to be validated by the shared Rust/WASM core.

When changing the Rust boundary, refresh the checked-in artifact with
`ANT_CLIENT_DIR=/path/to/ant-client-web-support npm run sync:wasm` (the sibling
web-support worktree is the default), update the TypeScript types,
and test both the SDK and the real-browser demo against a browser-enabled devnet.

Commit the generated `src/wasm` bindings, binary, and `source.json` together.
The provenance file records the source revision and binary checksum. Run
`npm run build:examples` and `npm pack --dry-run` to check the shipped assets.
