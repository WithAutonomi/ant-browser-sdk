# Rebuilt WASM from rebased `web-support` — 2026-09-22

The SDK now bundles release WASM from ant-client
`04c64fa6446cf2141117b8e5cae42f8b5b07bbf6`, the head of `origin/web-support`,
built from a clean detached worktree with `--no-default-features --features
browser-wasm` for `wasm32-unknown-unknown`. This supplements
[the persistent-RPC audit](2026-09-21-persistent-rpc-multiplexing.md), which
validated the same browser transport code at the pre-rebase revision.

## What changed in the source

`origin/web-support` was rebased onto ant-client `main`. Compared with the
previously bundled `f9388445618f2605e01f5121f7f9f69a82af5b42`, the tree differs
only in workspace manifests and the lock file; `ant-core/src` is byte-identical.

| Dependency | Previous | Now |
| --- | --- | --- |
| ant-core (workspace) | 0.8.1 | 0.9.0 |
| ant-node | 0.18.1 @ `e8e674348954864e280f859c94430fec55f030d9` | 0.19.0 @ `50167d39b8acc03ae771e790ef54b060a8d8ea72` |
| ant-protocol | 2.3.5 @ `f6e86dd16d5b9e86e7e1df44d6c3b72b933135d4` | 2.4.0 @ `1764950d7af880aa13af679ac8c2d0fcbcde0776` |
| saorsa-core | 0.27.3 @ `0df7853ea24242694e91c67631986d6bea686199` | 0.27.4 @ `02dd65fc4df68f326b8d7ed0bd0e3ffb6c29329c` |
| saorsa-transport | 0.36.3 @ `6f0b1f623b487a222187e38d1e7fb25eb2f876cb` | 0.36.4 @ `3ed66a9c0880583ceab1e1550dce756e2716d111` |

ant-node `50167d39` is the `web-support-optimizations` head: the bounded
concurrent RPC handling and active-request idle-deadline commits from the
previous audit, rebased onto the re-pinned node `main` lineage.

The generated bindings changed only in wasm-bindgen closure shim hashes. No
exported function, type, or SDK public API changed.

## Artifact provenance

- WASM SHA-256:
  `601896dcdc10f153aacacdbb13ad4d18d0579913d735416df461383a19dc1f36`
  (5,039,136 bytes).
- Client Cargo.lock SHA-256:
  `54887c9f52216c51297468d2305343041aa1f5ffd332c8526f8654f132a971d7`.
- Previous WASM revision `f9388445618f2605e01f5121f7f9f69a82af5b42`, SHA-256:
  `124c159de1edcfd9bcbb77a6e5b3b035633c646ee1dbb0db84247284e1a722d9`.
- Toolchain: wasm-pack 0.15.0, Node.js 22.23.1.

## Validation

Run sequentially from the SDK root:

```sh
ANT_CLIENT_DIR=<clean worktree at 04c64fa> npm run sync:wasm
npm run check
npm run build:examples
npm pack --dry-run
python3 scripts/adr-governance.py
```

- `npm run check`: build, TypeScript checks, and 158 tests in 19 files passed,
  including the provenance/checksum boundary test against the new binary.
- `npm run build:examples`: all five examples built with the refreshed WASM.
- `npm pack --dry-run`: 80 files, including WASM, bindings, and provenance.
- ADR governance passed for the three checked-in records.

Downstream, the sibling `ant-file-vault` application (which depends on this
checkout through `file:../ant-client-browser-sdk`) was rebuilt with
`npm run sdk:prepare`, `npm run build`, `npm test` (44 tests in 7 files) and
`npm run test:browser` (4 Playwright tests passed, 1 wallet test skipped as
usual). Its production bundle embeds the new WASM with the SHA-256 above and
the copied streaming service worker is unchanged.

## Limitations

- No real-browser upload/download was run against a devnet built from ant-node
  `50167d39` for this rebuild. The browser transport code is identical to the
  revision exercised in the previous audit, but the rebased dependency graph
  (ant-protocol 2.4.0, saorsa-core 0.27.4, saorsa-transport 0.36.4) has not
  been exercised end to end from this SDK build.
- The WAN comparison left open in the previous audit remains open.
