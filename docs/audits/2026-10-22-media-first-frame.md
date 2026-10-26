# Media first frame: plain reader, no serial waits, Firefox keep-awake — 2026-10-22

[try.autonomi.com](https://github.com/WithAutonomi/try/pull/18), which uses the
same core directly, started its video sooner than `createMediaSource()`. This
change brings what it does differently into the SDK, measured with the SDK's
own media path. It was first proposed separately (PR #8) and is part of the
0.1.3 release.

## Changes

- `createMediaSource()` opens its reader without the core's streaming mode.
  That mode starts fetching up to four records of the next 32 MiB, and the
  file's last record, alongside the first block a player waits for. The plain
  reader still reads ahead once a read continues a previous one.
- The media service worker installs while the reader opens, and the head and
  tail are primed as soon as the reader is open, instead of each waiting for
  the one before. An open failure still surfaces first; a worker failure
  surfaces once the reader has opened, which is then closed.
- While any media source is open the page messages the worker every 10 s, and
  the worker listens. Firefox stops a worker that has had no new event for
  30 s, even one still answering a request.
- The worker waits up to 120 s for a block instead of 45 s: the core retries a
  missing record after 15 and after 45 s. Its responses carry
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
  default-src 'none'`, since their type comes from the file's metadata.

No public type, core or wire change. Applications that merged the packaged
worker into their own should merge its new `message` listener too.

## Revisions

- Baseline: SDK `8c00e820feea25d344c9b83bad8466740c52fbdb`, the 0.1.3
  release commit before this change.
- Candidate: the same commit plus this change; the built `client.js`,
  `internal/media.js` and worker hashes in
  [`checksums.json`](2026-10-22-media-first-frame/checksums.json) are those
  measured.
- WASM in both: ant-client `8b19c1499360ebd8166a1ef3dd65b88db914dd7f`,
  `0c01cd4377a4b4846ae989691317738b909a83ce95e81ea62ce1833391a794a8`. The
  release now bundles the WASM from `ccd4106`, whose browser, data and
  read-engine source is unchanged from `8b19c14`
  ([2026-10-26 audit](2026-10-26-ant-client-main-ccd4106.md)); these timings
  were not repeated on it.
- Video: try's featured 54,903,201-byte MP4, read from its manifest
  (`content/manifests/video.ant`, embedded root map), so no DataMap is fetched.
- macOS 26.5.2 arm64; Node 22.23.1; Playwright 1.62.1; Chromium
  151.0.7922.34, Firefox 153.0, WebKit 26.5.

## First frame on the live network

[`harness.js`](2026-10-22-media-first-frame/harness.js), identical in both
builds, connects with `AutonomiClient.connect()` on mainnet defaults when the
page opens, waits 3 s, then creates a media source for the video, plays it
muted, and records the first decoded frame (`requestVideoFrameCallback`), ten
seconds of playback, a seek to the middle and every read the reader served.
[`drive.mjs`](2026-10-22-media-first-frame/drive.mjs) ran ten alternating rounds,
each in a fresh Chromium context.

| Build | First frame (s) | Median | Seek to middle, median |
| --- | --- | ---: | ---: |
| Baseline | 6.1, 11.0, 5.8, 9.1, 7.3, 10.6, failed, 11.3, 8.4, 9.6 | 9.1 | 3.4 s |
| Candidate | 7.2, 4.5, 13.3, 5.2, 5.6, 6.7, 9.6, 6.5, 7.7, 5.4 | 6.6 | 6.5 s |

The candidate was faster in 7 of 10 paired rounds. One baseline sample failed:
the player reported no supported source. Every other sample played at least
ten seconds in ten, with two `waiting` events each.

In every sample the first frame is the read of the first 1 MiB, which waits
for the file's first record; every block after it came from the reader's cache
in about 30 ms. The spread is that one record's fetch on the live network,
which was slower in the afternoon than the morning's try runs, plausibly
because the day's runs made it hot for its holders.

The seek was slower in this batch: streaming mode had, after ten seconds,
already fetched the window holding the middle of this file, which the plain
reader fetches when asked.

Two later batches of the same two builds, run alternately with variants of a
core read-ahead change that was not adopted, put the plain reader ahead by
less: median first frame 7.8 s against
9.7 s, then 8.8 s against 9.2 s over 15 rounds. In that 15-round batch the
plain reader also sought faster, median 2.8 s against 5.1 s, so seek times
swing too much between batches to show a difference either way. Their raw
results were not kept. A trace of the core read on 2026-10-26 (ant-client
`ccd4106`) puts most of a first record's time in discovery reaching the
holder, a median 1.4 s, and its handshake, 0.6 s, which neither reader mode
changes.

The same comparison in try's own page, with the same core, gave a median
first frame of 5.0 s with a plain reader against 8.4 s in streaming mode,
three rounds each.

## Firefox

[`firefox-keepalive.mjs`](2026-10-22-media-first-frame/firefox-keepalive.mjs)
([results](2026-10-22-media-first-frame/firefox-keepalive.jsonl)) lowers
Firefox's worker idle limits to 15 s and 1 s and serves, through the
SDK's `MediaBridge` and packaged worker, a reader that takes 22 s per block. The
baseline answered `206` with an empty body after 15 s: the worker was stopped
mid-answer. The candidate answered the ten requested bytes after 22 s, after
two keep-awake messages, and sent none once the source closed.

[`playback.mjs`](2026-10-22-media-first-frame/playback.mjs) plays a test-pattern
MP4 through the same bridge and worker in Chromium, Firefox and WebKit
([results](2026-10-22-media-first-frame/playback.jsonl)): each
played past half a second, with the new response headers present.

## Automated validation

- `npm run check`: build, TypeScript and **262 tests in 23 files passed**. New
  tests: the worker installs while the reader opens and priming starts before
  it is ready, with a plain reader; a failed worker surfaces once the reader has
  opened and closes it; the bridge does nothing more once its worker controls
  the page; keep-awake messages every 10 s only while a source is open; the
  worker's message listener, timeout and headers. Five of them fail against the
  baseline source; the failed-worker ordering test passes on both and guards
  the new parallel setup.
- `npm run build:examples`, `npm pack --dry-run` (97 files), `npm run
  verify:wasm`, ADR governance (8 ADRs) and all 52 PR-checker cases passed.

## Limits

Ten recorded samples per build, and the later batches' medians only, from one
machine and network; Chromium only for live timings, one video. Live node load
and versions are unknown. The plain reader led the first frame in every batch,
by 0.4 to 2.5 s at the median; no seek difference is claimed.
