# Contributing

Use Node.js 20.19 or newer and run `npm run check` before submitting a change.
Public APIs must remain typed, browser capabilities must be feature-detected, and
untrusted protocol data must continue to be validated by the shared Rust/WASM core.

When changing the Rust boundary, refresh the checked-in artifact with
`ANT_CLIENT_DIR=/path/to/ant-client npm run sync:wasm`, update the TypeScript types,
and test both the SDK and the real-browser demo against a browser-enabled devnet.
