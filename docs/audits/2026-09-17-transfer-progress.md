# Transfer progress validation — 2026-09-17

The vault now displays per-file quote/store/download counts, retains SDK progress
diagnostics in a bounded live log, persists transfer durations, and starts media
playback when ready with a muted fallback. The browser core emits download record
completion diagnostics and reports confirmed stores before the full wave settles.
Merkle preflight forwards quote completion through the existing upload adapter.
No payment, quorum, encryption, or verification policy changed.

## Revisions

- SDK source base: `0638be55a4d368e198f539d2bfd4b4b63bff132c`.
- Core source base: `f1303e1ad7bab49c8dc12af030ba71ec5fca0237`, with local observer
  changes. `src/wasm/source.json` correctly records `dirty: true`; this is a local
  development artifact, not a clean release build.
- WASM SHA-256: `74b1daa5671790dd6ee03b5408deeabf1fb42b8a063c322b90c7a1ef1dfefb3d`.
- Remote node revision was not established in this run because connection failed.

## Checks

- `npm run sync:wasm`: passed (wasm-pack release build and generated bindings).
- `npm run check`: SDK typecheck and 158 tests passed.
- `npm run build:examples`: all five examples built.
- `npm pack --dry-run`: passed, including prepack checks.
- `cargo test -p ant-core --lib --no-default-features --features native`:
  696 tests passed, including compilation of native Send assertions.
- Vault `npm run build`: passed.
- Vault `npm test`: 43 tests passed. Coverage includes out-of-order and duplicate
  quote callbacks, separate store/download counters, bounded logs, timing history
  roundtrips, live filtering and muted autoplay fallback.
- Vault `npm run test:browser`: four passed, one existing wallet test skipped.

## Live-browser limitation

Launched the built vault with Chromium on an isolated localhost preview server
and attempted an authenticated connection to the saved web-support devnet endpoint
`178.128.149.0:57945`. The real WASM initialized; the WebRTC DataChannel timed out
in about ten seconds. The live log correctly displayed initialization,
authentication, terminal failure, and the detailed application error. Inspected
the resulting full-page screenshot. No payment or upload was attempted. Full
network transfer counter behavior and real streamed-video autoplay remain
unverified against a reachable compatible devnet. Temporary evidence:
`/tmp/ant-vault-progress-live.txt` and `/tmp/ant-vault-progress-live.png`.

## Committed artifact refresh

Before pushing, rebased the observer changes onto the latest `web-support` branch,
including `b521951` and `d4be352`. Rebuilt from clean tracked client sources at
`3df0d1af816dc17689850cad498751f25adc3bdd`. The committed artifact's provenance now
records `dirty: false` and WASM SHA-256
`7d1945c0708fe32794d73860b568d0e35bcd83e1900b65bf4a311af22d863b25`.
Re-ran the native library suite (696 passed) and SDK `npm run check` (158 passed,
including production WASM tests) after this refresh. The earlier live-network
limitation still applies; no further live transfer was attempted.
