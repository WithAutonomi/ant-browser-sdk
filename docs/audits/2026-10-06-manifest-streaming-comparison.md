# 2026-10-06: Streaming from a public address versus an embedded manifest entry

Measurement of the manifest feature (ADR-0007; ant-client ADR-0006) in a real
browser against mainnet. Not a test; a dated record of what was observed.

## Setup

- SDK: this branch (`feat/manifests`, 6d6762b), WASM synced from ant-client
  `adr-0006-file-manifests-and-links` 8afb802 (WithAutonomi/ant-client#219).
- Browser: headless Chromium (Playwright 1.62.1), WebRTC Direct to the SDK's
  bundled mainnet seeds. Service worker served from the page origin.
- File: `134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889`,
  a 612 MB MP4 (147 chunks, shrunk DataMap with three nested wrapper records).
- Manifest: `ant manifest create --name sindbad --embed-public <address>=sindbad.mp4`
  on mainnet, shared as an `ant://manifest/...` link (718 characters, DataMap
  320 bytes). Parsed in the page with `parseManifestLink`; the entry was passed
  to `client.createMediaSource` as is. The address path passed the hex address.
- One streaming start = `createMediaSource()` resolving ("media"), then a
  1 MiB range read of the head and a 64 KiB range read of the tail through the
  service worker URL, as a video player does before playback.
- Cold: a brand-new browser context, a new client, one start, close; paths
  alternated; four runs each. Nothing can be cached across runs.
- Warm: one context and one client for the whole series; both paths streamed
  once as warm-up, then four alternating measured starts each on the same
  client.

## Results, medians (individual runs in brackets), milliseconds

### Cold start

| Path | Connect | Media ready | Head 1 MiB | Tail 64 KiB | Total |
|---|---|---|---|---|---|
| Public address | 2 352 | 10 398 [8 936, 19 553, 8 146, 11 859] | 10 620 | 234 | 24 768 [22 269, 28 828, 18 462, 27 268] |
| Manifest, embedded | 2 363 | 3 223 [3 241, 4 045, 2 973, 3 205] | 11 471 | 1 532 | 16 270 [16 956, 16 081, 16 459, 15 693] |

In every cold address run the progress log shows "Verified public DataMap"
only after 5.6 to 13.7 s; the manifest path starts resolving the nested
records at once. Head and tail reads are the same work on both paths and
vary with the network; the whole difference is in "media ready".

### Warm start

| Path | Media ready | Head 1 MiB | Tail 64 KiB | Total |
|---|---|---|---|---|
| Public address | 8 445 [8 826, 9 736, 8 064, 1 551] | 5 424 | 78 | 12 529 [10 847, 14 211, 15 379, 8 079] |
| Manifest, embedded | 1 410 [114, 1 221, 5 013, 1 599] | 3 532 | 134 | 6 784 [1 740, 4 986, 8 581, 10 655] |

Warm-up starts: address 20 120 total, manifest 7 505 total.

## Observations

- Cold, the embedded manifest entry reaches a playable state about 8.5 s
  sooner at the median, and its spread is far smaller (3.0 to 4.0 s against
  8.1 to 19.6 s to media ready). The saving is the DataMap record fetch, one
  lookup plus one GET on a cold routing table.
- Warm, the address path still paid for the DataMap fetch in three of four
  runs (6.9 to 7.8 s to "Verified public DataMap"), and hit the cache once
  (1.3 s). The cause is in `BrowserNetworkClient::get_shared_chunk` in the
  core: a record is served from the chunk cache only while its source-node
  metadata is still in a separately bounded table; after that metadata is
  evicted by the streaming reads, the cached record is removed and fetched
  again. The nested wrapper records are subject to the same rule, which is the
  5.0 s outlier on the manifest path. Keeping DataMap and wrapper records
  cached independently of source metadata would remove most of the warm-start
  gap; that is a core change outside this SDK branch.
- Head reads of 1 MiB took 2 to 7 s even warm, so the chunk cache does not
  retain the file's data chunks across media sources either.
- One file, one afternoon, one network state. Absolute times will move;
  the structural difference, one fewer record fetch before playback, will not.

## Commands

The page, static server and Playwright driver used are the
`stream-bench.html`, `server.mjs` and `run-stream.mjs` scripts kept with the
ant-client#219 review notes; `RUNS=4` produced the figures above.

## Rerun on 2026-10-07 with root-map embedding and playback priming

Same harness, same file, four runs each. SDK `feat/manifests` at 5b971e7
plus the priming commit; WASM synced from ant-client 61d0a24, whose
`--embed-public` now embeds the 147-entry root DataMap (manifest 21 KB)
and records the file's published address beside it. The address path is
unchanged in code and serves as the control for network variance.

### Cold start, medians (individual runs in brackets), milliseconds

| Path | Media ready | Head 1 MiB | Tail 64 KiB | Total |
|---|---|---|---|---|
| Public address | 7 666 [6 985, 7 794, 7 537, 7 923] | 10 402 | 420 | 18 435 [15 527, 17 627, 24 290, 19 243] |
| Manifest, root embedded | 22 [25, 20, 25, 18] | 14 034 [11 955, 22 430, 15 954, 12 114] | 2 | 14 058 [11 982, 22 453, 15 982, 12 135] |

### Warm start, medians, milliseconds

| Path | Media ready | Head 1 MiB | Tail 64 KiB | Total |
|---|---|---|---|---|
| Public address | 5 630 | 4 232 | 42 | 10 943 |
| Manifest, root embedded | 2 | 4 394 | 3 | 4 399 |

### Observations

- Media ready on the manifest path fell from 3.2 s to 22 ms cold: with the
  root map embedded there is no DataMap fetch and no wrapper-record fetch
  before the reader is ready ("Using private DataMap (16016 bytes)", then
  "Ready to stream").
- The tail read fell from 1.5 s to 2 ms: priming had already fetched the
  last record alongside the first.
- Time to playable is now the first-chunk fetch alone: 12 to 22 s cold.
  Its median rose from 11.5 to 14.0 s; the control path moved by a similar
  margin, and priming now downloads the last record concurrently with the
  first over freshly dialed connections, so the head shares bandwidth it
  had alone before. Overall cold start improved from 16.3 to 14.1 s and
  warm from 6.8 to 4.4 s. Reducing the first-chunk fetch (racing holders,
  and measuring lookup against dial against transfer) is the next lever.
- The first attempt of this rerun exposed a bug: embedding the root map
  changed the entry's content address away from the file's public address.
  Fixed in ant-client 61d0a24 before these figures were taken.
