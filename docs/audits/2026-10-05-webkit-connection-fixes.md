# WebKit connection fixes — 2026-10-05

Validates SDK 0.1.2. It bundles ant-client main `9858af5`, which adds two browser transport fixes to the ant-core 0.11.0 build that SDK 0.1.1 ships (`db85c72`):

- [ant-client#215](https://github.com/WithAutonomi/ant-client/pull/215): the transport no longer reuses a connection that the browser reports `failed` or `closed`, and requests waiting on such a connection fail at once.
- [ant-client#216](https://github.com/WithAutonomi/ant-client/pull/216): one connection in a page gathers ICE candidates at a time.

## Problem

In Safari (WebKit), downloads and media playback with SDK 0.1.1 stalled for minutes in some runs. A reviewer measured this on try PR #13 (WithAutonomi/try#13) in 5 of 14 runs. The cause is a chain of three behaviours:

1. **WebKit's socket cap.** WebKit allows 256 WebRTC UDP sockets per page and closes the oldest once a page exceeds that, without notice; the macOS log shows `NetworkRTCProvider::too many sockets, closing N`. A connection gathering ICE candidates on its own opens 2 sockets. Connections whose gathering overlaps open many more: 12–30 each on the test machine, though their SDP still shows 2 candidates.
2. **Burst dialling.** The client dials in bursts (lookup rounds and preconnects), so pages reached the cap within about 20 s.
3. **Silent loss and reuse.** A connection whose sockets are closed goes silent. The node drops the association after 5 s of silence, and WebKit reports `disconnected` and then `failed` 10 s later. WebKit never fires `close` on that connection's DataChannels, which keep reading `"open"`. The 0.1.1 transport judged liveness by its channels alone, so it kept reusing dead connections and waited out request deadlines on them.

Chromium opens 2 sockets per connection however dials overlap, and it lost no connections in any run.

## Provenance

- SDK: branch `build/sync-ant-core-webkit-fixes`, version 0.1.2.
- Production WASM: ant-client `9858af5dbbb2caf090e20db67ac62aa4bd100c81` (main), clean checkout via `npm run sync:wasm`.
  - WASM SHA-256: `ab58bd3e331436d22acfe3d08b384992be9addec52145fa0325468c27b6da70a`.
  - Cargo.lock SHA-256: `51412fd6…` (unchanged from 0.1.1).
  - The bindings' exports are unchanged; only wasm-bindgen's internal closure-shim names differ.
- Baseline: the published `@withautonomi/ant-browser-sdk@0.1.1` (WASM `8fa35e58…`, ant-client `db85c72`).
- Tools: Node v22.23.1, Rust 1.96.1, wasm-pack 0.15.0. Playwright 1.62.1 (WebKit 26.5, Chromium 151), macOS.

## SDK checks

- `npm run check`: 188/188 tests.
- `npm run verify:wasm`: ant-client `9858af5` is on main and the WASM matches its recorded hash.
- `npm run build:examples`: all five built.
- `npm pack --dry-run`: 89 files, 2.2 MB.
- ADR governance passed.

The ant-client PRs carry their own generated-WASM regression tests: 199/199 on the merged head.

## Comparison: 0.1.1 against 0.1.2 on mainnet

**Downloads through the try page.** The try.autonomi.com page was served locally with each SDK's bundled core. Each run used a fresh browser and the order alternated. A run downloaded `Welcome.md` (574 B), then `Mandelbrot zoom.mp4` (11.5 MB). Every RTCPeerConnection and DataChannel event was traced, and WebKit's `NetworkRTCProvider` log was matched to each run by wall-clock time.

| WebKit, 6 runs each | 0.1.1 | 0.1.2 |
| --- | ---: | ---: |
| `Welcome.md` median (range) | 41.8 s (35.1–58.5) | **31.1 s (30.6–33.3)** |
| Video median (range) | 22.0 s (8.8–271.9) | **12.3 s (8.3–14.9)** |
| Downloads over 120 s | 2 (271.9 s, 200.5 s) | **0** |
| Connections that failed, per run | 5–33 | **0** |
| Requests sent into failed connections | 19 and 7 (in the two stalled runs) | **0** |
| Peak sockets / WebKit forced closes per run | 257 / 374–1,072 | **98–114 / 0** |

| Chromium, 4 runs each | 0.1.1 | 0.1.2 |
| --- | ---: | ---: |
| `Welcome.md` median | 31.7 s | 32.9 s |
| Video median (range) | 9.3 s (7.6–11.8) | 10.6 s (9.3–12.4) |
| Connections that failed | 0 | 0 |

**Video streaming through the SDK.** `createMediaSource()` played the 12 s Mandelbrot video in a `<video>` element, one fresh browser per run, order alternated. The time to first frame is measured from the `createMediaSource()` call. A stall during playback is the finish time minus the first frame minus 12 s.

| WebKit, 4 runs each | 0.1.1 | 0.1.2 |
| --- | --- | --- |
| Time to first frame | 9.9 / 14.1 / 14.5 s; one run failed | **6.6 / 9.0 / 9.9 / 11.0 s** |
| Playback | one clean; one 10.1 s stall; one unfinished within 30 s; one failed to load (`NotSupportedError`) | **all 4 clean** |

| Chromium, 4 runs each | 0.1.1 | 0.1.2 |
| --- | --- | --- |
| Time to first frame | 6.3 / 9.4 / 9.4 / 16.1 s (median ~9.4 s) | 10.4 / 10.7 / 10.7 / 11.8 s (median ~10.7 s) |
| Playback | all 4 clean | all 4 clean |

## Earlier measurements behind the fixes

The ant-client PRs record the investigation:

- Matched WebKit runs on mainnet with each fix applied separately.
- WebKit's real socket count, without network, under different gating strategies. Only waiting for the previous gathering to complete, or spacing gathering starts at least 150 ms apart, keeps every connection at 2 sockets.
- A network-free reproduction. Idle connections gathering together in a page cut off an established connection in WebKit (6 of 66 messages delivered) but not in Chromium (66 of 66).

The probes and their raw results are in [the evidence directory](2026-10-05-webkit-connection-fixes/).

## Limits

- These are live mainnet samples of 4–6 runs per arm, not a controlled benchmark.
- In Chromium, 0.1.2 serializes ICE gathering, which it does not need. The cost was about a second on the medians here, within the run-to-run spread.
- All WebKit runs used Playwright's WebKit build on one macOS machine with many network interfaces, including VPN `utun` devices. How many sockets an overlapping gathering opens depends on the interfaces.
- Safari on iOS was not tested.
