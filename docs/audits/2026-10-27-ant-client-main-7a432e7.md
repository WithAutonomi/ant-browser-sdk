# WASM rebuilt from ant-client main `7a432e7`, compared with 0.1.3 — 2026-10-27

ant-client main moved to `7a432e7c4442b4628872bd5cf6a3e896e7fc10ad`, which merges
WithAutonomi/ant-client#222 (V2-1483): browser downloads from mainnet spent most
of their time dialling. The bundled WASM is rebuilt from it for 0.1.4, and the
result is compared with the published 0.1.3 through the SDK's own API on
mainnet.

## What the rebuild changes

ant-client [#222](https://github.com/WithAutonomi/ant-client/pull/222), recorded
in its ADR-0004 section "Dial failure and ICE gathering (2026-10-26)":

- A fresh dial fails when ICE has not connected 3 s after its offer, instead of
  holding a connection-pool slot until the 10 s channel-opening timeout. About
  half the WebRTC Direct endpoints a browser dials on mainnet never answer.
- Chromium dials gather ICE candidates at once rather than waiting for the
  page's gathering turn. WebKit and Firefox keep the turn.
- A Chromium client starts with 8 GETs in flight instead of 4; other engines
  start at 4 and can grow to 8.
- The early-read hedge delay is 3 s in the browser instead of 1 s, and runs from
  when a GET is dispatched to its peer.
- Each node session admits read-ahead within half its slots, and a GET a read is
  waiting for, such as a seek's, is promoted ahead of queued read-ahead.

Main also took tokio 1.53.3 for a RustSec advisory (#241) and a test-only change
(#226). The SDK's public API, its TypeScript and the bindings' declarations are
unchanged: `dist/client.js` is byte-identical to 0.1.3's. The generated
JavaScript gains one browser import, for `Reflect.has`, and its closure shims are
renumbered; the notices change only tokio's version.

## Revisions

- SDK: this branch, `7e618c0` (the rebuilt WASM) and `f6d7394` (version 0.1.4).
- WASM from clean ant-client main `7a432e7c4442b4628872bd5cf6a3e896e7fc10ad`,
  SHA-256 `7873c65138aa499c48a8c34d9dbaa2fdd82509ca6e981afe9a4f77331b9e4cf4`,
  `Cargo.lock` `5fbd0fe94e28fc0d81f4b763a3d12fc2e0f67bcba26d908a06ac7ff6bd724f1e`;
  provenance in [`source.json`](2026-10-27-ant-client-main-7a432e7/source.json).
- Baseline: the published `@withautonomi/ant-browser-sdk` 0.1.3 package's
  `dist/`, WASM `08ae5d0cc7b96458ba9899d68be0455b276848644237f42704419a2e4311fec4`
  from ant-client `ccd4106`.
- macOS 26.5.2 arm64; Node.js 22.23.1; Rust 1.99.0; wasm-pack 0.15.0;
  Playwright 1.62.1 with Chromium 151.0.7922.34 and WebKit 26.5.

## Automated validation

- `npm run verify:wasm` **passed**: `7a432e7` is on main, and the binary and
  licence hashes match.
- `npm run check`: build, TypeScript and **272 tests in 24 files passed**.
- `npm run build:examples`: all five Vite applications passed.
- `npm pack --dry-run --json`: `withautonomi-ant-browser-sdk-0.1.4.tgz`, 97 files.
- ADR governance (8 ADRs) and all 52 PR-checker cases passed.

## Compared with 0.1.3 on mainnet

[`ab.mjs`](2026-10-27-ant-client-main-7a432e7/ab.mjs) serves each build's `dist/`
on its own local origin with
[`harness.js`](2026-10-27-ant-client-main-7a432e7/harness.js), and runs every
sample in a fresh browser context. The page connects with
`AutonomiClient.connect()`; once connected, and 3 s more, it either downloads the
64 MiB public file `f6eeba94008f493a8518186b0647df6d39dbde75f41d5b79549e9a4e63a1ab43`
(try.autonomi.com's "64 MB of random bytes") with `download()`, or streams try's
featured 54.9 MB video from its manifest with `createMediaSource()`. A stream is
timed to its first decoded frame, plays for ten seconds, then seeks to 85% of the
video: beyond the 32 MiB read-ahead window and before the last record. The two
builds alternate, in rotating order, between 15:11 and 15:36 UTC on one network,
with the machine otherwise idle.

| Measure | Rounds | 0.1.3, per round (s) | 0.1.4, per round (s) | Median 0.1.3 → 0.1.4 | 0.1.4 faster |
| --- | ---: | --- | --- | ---: | ---: |
| Download, Chromium | 6 | 36.3, 37.3, 33.3, 35.5, 42.1, 40.3 | 26.3, 24.6, 34.0, 32.7, 31.6, 26.6 | 36.8 → 29.1 s | 5 of 6 |
| Download, WebKit | 5 | 48.4, 35.3, 37.2, 45.2, 33.8 | 36.9, 35.2, 56.5, 36.5, 40.3 | 37.2 → 36.9 s | 3 of 5 |
| First frame, Chromium | 10 | 4.3, 5.5, 8.7, 3.4, 3.6, 2.7, 3.5, 4.3, 3.4, 7.5 | 4.7, 3.4, 6.0, 3.0, 3.1, 4.3, 3.9, 4.0, 8.5, 3.8 | 3.9 → 3.9 s | 6 of 10 |
| Seek to 85%, Chromium | 10 | 17.7, 4.6, 10.7, 4.4, 20.1, 7.2, 6.0, 20.0, 12.7, 3.8 | 3.3, 5.4, 2.2, 1.6, 1.4, 15.1, 2.1, 2.8, 1.8, 1.9 | 9.0 → 2.2 s | 8 of 10 |

Every download matched the file's SHA-256
(`f2ea3b460153845ded67562b9a7c994401f49d604548952962ff7a3ebebf68fc`), every stream
played at least five seconds in ten, and no page reported an error.

- **Chromium downloads are faster**: a median paired saving of 10.2 s, 28%. The
  client opened more connections (median 229 against 177), as dead endpoints fail
  sooner and are replaced, and received less (102 MB against 116 MB for 67 MB of
  file), consistent with fewer hedged duplicate GETs. `connect()` took 2.1 s
  instead of 2.4 s.
- **WebKit downloads did not change.** #222 keeps WebKit's gathering turn and its
  start of 4 GETs, since overlapping gatherings cut its established connections.
  #222 measured real Safari 26.5.2 faster (25.5 s against 31.5 s for this file);
  Playwright's WebKit is not Safari, and Safari was not measured here.
- **The first frame did not change.** It waits for discovery to reach the first
  record's holder and connect to it, which #222 does not shorten
  ([2026-10-26 comparison](2026-10-26-sdk-vs-try-streaming.md)).
- **Seeking far ahead is much faster**: 0.1.3 took over 10 s in five of ten
  seeks, 0.1.4 in one. A seek's records need new lookups and dials, where dead
  endpoints now cost 3 s instead of 10 s, and its GETs no longer queue behind
  read-ahead.

Raw results: [Chromium downloads](2026-10-27-ant-client-main-7a432e7/download-chromium.jsonl),
[WebKit downloads](2026-10-27-ant-client-main-7a432e7/download-webkit.jsonl),
[Chromium streams](2026-10-27-ant-client-main-7a432e7/stream-chromium.jsonl) and
[their summary](2026-10-27-ant-client-main-7a432e7/summary.txt).

## Limits

Five to ten rounds per measure from one machine and network, against live nodes
whose load and versions are unknown; mainnet speed varies between rounds and
days, so only same-run pairs are compared. One 64 MiB file and one video. Real
Safari and Firefox were not measured. The real-browser devnet run of earlier
releases was not repeated for this rebuild; #222's own CI ran its transport
changes in real Chromium against local nodes.
