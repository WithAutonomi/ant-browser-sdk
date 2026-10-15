# Manifest compatibility review — 2026-10-15

Reviewed SDK PR #6 at `f0c2addb99c659f3a008f7b361d55c62dc7181dd`
against ant-client main `225a6768589ecbb6a0c77d70df329f343b22776f`.
The PR bundles clean ant-client main
`9a2b6353a88207dd4d6ed99a5158c370531a7e09`.

The manifest implementation is current. `git diff 9a2b635 HEAD --
ant-core/src/data/manifest docs/adr/ADR-0006-file-manifests-and-links.md`
is empty in the clean upstream worktree. The `parseManifestLink`,
`decodeManifest`, `BrowserManifestView`, and `BrowserManifestEntryView`
implementations in `ant-core/src/browser.rs` are also unchanged. The SDK
surfaces every field, including optional `knownSize` and torrent hashes,
and routes embedded/public entries through the corresponding existing read APIs.

Upstream's separate `browser/manifest.rs` validates browser devnet descriptors,
not ADR-0006 `.ant` manifests. Its larger file-size/chunk limits belong with the
new 64-bit download and streaming implementation, which will be integrated on
a separate branch after this PR merges. That integration also brings shared
in-flight chunk fetches and the latest core dependency fixes. The browser upload
limit remains 1,000,000,000 bytes in current upstream main.

Validation on Node v22.23.1:

- `npm ci`: passed.
- `npm run check`: build, TypeScript and all 202 tests in 22 files passed,
  including the seven production-WASM manifest tests.
- `npm run verify:wasm`: passed for main ancestry and artifact/licence hashes.
- `npm run build:examples`: all five examples passed.
- `npm pack --dry-run --json`: passed, including prepack checks.
- `python3 scripts/adr-governance.py`: passed.
- `python3 .github/scripts/test_check_pr.py`: 52/52 passed.

No WASM or runtime code changed in this review. The exact-byte real-browser
devnet evidence for this binary remains in the
[2026-10-08 audit](2026-10-08-ant-client-main-sync.md); it was not rerun here.
This source comparison does not claim validation of the newer streaming binary.

The manifest issue is `V2-1478`, recorded by the merged
[ant-client PR #219](https://github.com/WithAutonomi/ant-client/pull/219).
Use it to replace PR #6's obsolete `V2-TBD` placeholder.
