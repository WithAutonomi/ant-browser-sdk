# Streaming start: the SDK against try.autonomi.com — 2026-10-26

Does `createMediaSource()` now start a video as soon as
[try.autonomi.com](https://github.com/WithAutonomi/try/pull/18)'s own player,
which calls the same core directly? Both were measured side by side, with the
same core build, video and browser.

## Variants

Each variant was served from its own local origin, and all three bundle the
WASM from ant-client main `ccd4106dd8fd60545bbd31c40d46cc041f85fb8d`
(`08ae5d0cc7b96458ba9899d68be0455b276848644237f42704419a2e4311fec4`):

- **SDK before:** SDK `56f4f6d`, before the media change: `createMediaSource()`
  opens its reader in the core's streaming mode. Built with `npm run build` from
  that commit.
- **SDK now:** SDK `d06c176`: a plain reader, with the worker installed while
  the reader opens.
- **try:** try#18's branch at `b059697`, packaged with its `package-site.mjs`
  using the same core, its mainnet network file and live catalogue. Its seeds
  are the SDK's mainnet defaults. Its bindings are byte-identical to the
  `ccd4106` build's, so only the WASM differs from its vendored copy. Its player
  opens a plain reader and primes the first 1 MiB and the last 64 KiB, as the
  SDK does.

The video is try's featured 54,903,201-byte MP4, read from its manifest
(embedded root map). macOS 26.5.2 arm64; Node 22.23.1; Playwright 1.62.1;
Chromium 151.0.7922.34.

## Method

[`compare.mjs`](2026-10-26-sdk-vs-try-streaming/compare.mjs) opens each page
in a fresh Chromium context, waits until its client has connected and then
3 s more, as a visitor would, and starts the video. The SDK page is the
[2026-10-22 harness](2026-10-22-media-first-frame/harness.js), which calls
`createMediaSource()`; try's page gets a click on the video's Stream button.
Both are timed from that moment to the first decoded frame
(`requestVideoFrameCallback`), then ten seconds of playback and a seek. The
order of the three rotates each round; twelve rounds, 14:23 to 14:43 UTC.

The seek goes to 85% of the video
([harness](2026-10-26-sdk-vs-try-streaming/harness.js)). In a trial round
every variant reached the middle in about 50 ms: after ten seconds of playback
the middle is inside the reader's 32 MiB read-ahead window. 85% lies beyond it
and before the last record, which streaming mode fetches with the first.

[`diag.mjs`](2026-10-26-sdk-vs-try-streaming/diag.mjs) repeats the run for
SDK now and try, eight rounds from 14:47 to 14:54 UTC. It also records the
core's file opens and `readRange` calls on each page, and the player's range
requests. Both variants use the trace-enabled build of the same core revision
(`test-utils`, `3e68248e74ae4e8c0c42e122a4d50434025fee34e4c38705bd9ccbd430f697fe`),
whose trace reports each lookup and GET.

## First frame

| Variant | Run | Rounds | Median | Middle half | Range |
| --- | --- | ---: | ---: | ---: | ---: |
| SDK before | 1 | 12 | 5.6 s | 4.4–8.0 s | 3.5–21.1 s |
| SDK now | 1 | 12 | 6.1 s | 4.2–9.1 s | 3.2–18.1 s |
| try | 1 | 12 | 3.7 s | 3.2–4.4 s | 2.8–11.7 s |
| SDK now | 2, traced | 8 | 3.8 s | | |
| try | 2, traced | 8 | 4.4 s | | |
| SDK now | both | 20 | 4.5 s | 3.6–7.5 s | |
| try | both | 20 | 4.1 s | 3.4–4.7 s | |

Every sample played at least five seconds in ten, without a page error. Over
both runs the SDK showed the first frame sooner than try in 9 of 20 rounds;
the first run favoured try (4 of 12), the second the SDK (5 of 8). Five SDK
samples and two of try's took over 8 s, all in the first run.

SDK now was sooner than SDK before in 6 of 12 rounds, with a median paired
difference of 0.1 s the other way: in this batch the plain reader did not
start the video sooner than streaming mode. Seek medians were 10.2 s for SDK
before, 8.5 s for SDK now and 12.9 s for try, with middle halves spanning 5 to
19 s, too wide to compare.
[Results](2026-10-26-sdk-vs-try-streaming/compare-results.json) and
[summary](2026-10-26-sdk-vs-try-streaming/compare-summary.txt).

## The same network work

Medians of the traced run
([summary](2026-10-26-sdk-vs-try-streaming/diag-summary.txt),
[results](2026-10-26-sdk-vs-try-streaming/diag-results.json.gz)):

| | SDK now | try |
| --- | ---: | ---: |
| Lookups for the first record | 1 | 1 |
| GETs for it before its holder answered | 8 | 8 |
| The holder's GET started | 2.8 s | 2.7 s |
| The first record arrived | 3.7 s | 4.3 s |
| First frame | 3.8 s | 4.4 s |
| Other lookups and GETs meanwhile | 2 and 14 | 2 and 15 |

On both pages the first frame follows the read of the first 1 MiB within a
fraction of a second: a median 47 ms for the SDK and 75 ms for try. Both read
the head and the tail at once when the file opens. The SDK's player asks for
its first block at about 30 ms; try attaches its player once the head has
arrived. Neither costs anything: in all eight samples the SDK's two reads of
the first 1 MiB finished in the same millisecond, so they waited for one
fetch.

So with the same core, `createMediaSource()` does what try's player does and
starts as soon. What remains is the first record's fetch. A separate trace of
the core's reads on the same revision, over try's six files, put most of it
in discovery reaching the record's holder, a median 1.4 s, and that holder's
handshake, 0.6 s.

## Limits

Twenty rounds of SDK now and try, twelve of SDK before, from one machine and
network; Chromium only; one video. The SDK's heavier slow tail in the first
run came with no extra work in the trace, but twenty rounds do not rule one
out. Live node load and versions are unknown. The traced run used the
`test-utils` build of the same core revision.

## Files

`compare.mjs` and `diag.mjs` drive the runs, `summarize.mjs` and
`diag-analyze.mjs` produce the summaries, and `checksums.txt` holds the
hashes of the drivers and harness used.
