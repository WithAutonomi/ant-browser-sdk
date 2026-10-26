# ADR-0003: Adaptive browser downloads through the shared Rust scheduler

- **Status:** Proposed
- **Date:** 2026-09-17
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0002; ant-core shared read engine; 2026-09-17 download audit

## Context

The SDK defaults to three concurrent record fetches and the browser core clamps
requests to six. These fixed settings prevent the native adaptive scheduler from
responding to actual throughput. Browser discovery also shares ordered RPC work
with bulk responses, and previously waited for complete lookup rounds before
trying newly discovered holders.

## Decision Drivers

- Improve downloads across devices without selecting settings for one host.
- Retain shared native/browser integrity, retry, and absence policies.
- Bound speculative traffic and transient response memory.
- Preserve explicit application ceilings and cancellation cleanup.

## Considered Options

1. Increase the fixed browser concurrency constant.
2. Choose concurrency from processor count or a benchmark-machine profile.
3. Use the shared throughput scheduler with browser resource admission.

## Decision

We propose option 3. Omitted download concurrency and `"auto"` select the shared
Rust adaptive scheduler. Explicit integers from 1 through 256 remain logical
record-fetch ceilings; they do not force that many requests. The scheduler starts
at four and learns from verified useful bytes and completed operation timing.
Native and browser use the same shorter, evidence-bounded observation epochs.

The browser separately admits physical GETs, including speculative requests,
against a 128 MiB reservation budget for worst-case encrypted, plaintext, and
decoded responses. Eight-response windows reduce local admission when GET CPU
work occupies more than half the window and at least two processing or scheduling
stalls exceed 50 ms. Healthy windows recover gradually. An individual slow
response or a clamped background timer does not imply CPU saturation; halving
concurrency for either alone can unnecessarily serialize network waits. This is not a complete-file memory bound.

The shared read engine can fetch candidates before discovery completes. Content
and peer authentication remain mandatory; early misses never establish absence.
Browser control and bulk RPCs use two authenticated DataChannels on one WebRTC
association, avoiding the per-channel RPC queue without duplicating ICE setup.
Current nodes must allow two channels per association, their default setting.
There is no fallback for custom nodes configured to allow only one channel.

## Consequences

### Positive

- Ordinary SDK downloads can adapt without application tuning.
- Slow local processing can reduce physical admission below the network floor.
- Control work progresses independently of bulk RPCs.

### Negative / Trade-offs

- More useful concurrency can increase instantaneous bandwidth and memory use.
- The default and `SDK_LIMITS.downloadConcurrency.default` change from numeric
  three to `"auto"`; callers consuming the constant must handle its new type.
- Whole-file reconstruction and SDK byte/Blob copies still scale with file size.
- Two channels add a second authenticated session and require compatible nodes.

### Neutral / Operational

- No wire format, payment policy, or persisted storage format changes.
- Existing numeric settings 1–6 remain valid ceilings. No new dependencies.
- ADR-0002's explicit network identity and trust-anchor rules remain unchanged.
- Rebuild bindings, WASM, and source provenance together from clean Rust sources.

## Validation

Run shared native and browser tests, SDK checks, all example builds, package
inspection, and governance checks. Test bounded admission, cancellation, corrupt
content, slow processing, lane independence, and stale adaptive observations.
Repeat fresh-client downloads of the same public file on the same testnet using
native and browser clients, verifying byte count and an independent digest.
Include a CPU-throttled browser scenario; do not generalize one host to all devices.
Record revisions, exact results, and limitations in
[the dated audit](../audits/2026-09-17-adaptive-downloads.md).

## Notes for AI-assisted work

This ADR remains Proposed pending human engineering review. Accepted ADRs are
immutable; later changes require a superseding record.

## Bounded concurrent RPCs and cancellation (2026-09-17)

Nodes advertise `rpc-multiplex-4` in authenticated HELLO. Supporting clients may
have at most four uncompleted RPCs on each ordered DataChannel; older nodes keep
one. This ceiling is a protocol resource limit, not a device-specific throughput
setting. Global read memory/CPU admission and server source/rate/byte limits still
apply. Request IDs correlate out-of-order completions. One writer serializes whole
frames and AEAD sealing; one reader authenticates frames in wire sequence before
dispatch. Frames are not interleaved, and no cryptographic checks are removed.

Cancelling an admitted caller abandons its result, not its encrypted exchange.
The transport drains the response under ordinary deadlines, retaining its RPC
slot and any physical-read reservation. Unsent queued work remains cancellable.
Cancelled PUTs are not interpreted as failed payments or rolled back storage.
Explicit client closure and genuine transport/protocol failure close the session.
For a response already transferring, size-derived frame deadlines still apply;
first-response timers cannot cut an authenticated bulk frame short.

The server keeps receiving while work executes and while replies are written.
A channel reset retires channel I/O independently of tracked storage/payment
workers and their reservations. An excess replacement channel is rejected without
tearing down a healthy sibling channel. Admission remains bounded per channel,
connection, source, and listener. Wire request/response formats and native QUIC
behavior are unchanged; the capability is additive and old clients remain valid.

Draining preserves authentication but does not stop server work or reclaim bytes
already sent. A full response frame can still delay later responses on its lane.
Further wire-level cancellation or fragment interleaving would be a separate
protocol decision, justified by measured benefit and resource accounting.

Validation covers delayed work, out-of-order replies, cancelled active and queued
callers, authenticated-session reuse, old-node fallback, ingress limits, transfer
deadlines, and a real WebRTC blocked-storage regression. Live benchmarks compare
unchanged file bytes and integrity checks, elapsed time and received bytes.

PUTs retain exclusive per-lane admission, including through cancellation drain.
GETs and control RPCs may multiplex; enabling the capability does not multiply
large incoming uploads against the node's existing source byte limit.

## Playback priming at media-source creation (2026-10-07)

A player issues two sequential reads before it can play: the header, then
the index that MP4 and WebM files usually keep at the end. The streaming
reader already fetches the last record once the first read arrives; this
amendment moves both reads to the moment `createMediaSource()` resolves.
For audio and video content types, and common media extensions, the SDK
reads the first `mediaPrimeHeadBytes` (1 MiB) and the last
`mediaPrimeTailBytes` (64 KiB) at once in the background, so a player
attached afterwards is served from the reader's cache. The option
`primePlayback` forces or disables it. The reads are never awaited and
never fail the media source; a failure is left for the player to report.
No core or wire change: the reads use the ordinary streaming reader.

## Media readers open without streaming mode (2026-10-22)

The first frame waits on one fetch: the record holding the start of the
file. The core's streaming mode starts fetching up to four records of the
next 32 MiB, and the file's last record, at the same moment, so those
compete with it for the same connections. `createMediaSource()` now opens
an ordinary reader, which reads ahead only once a read continues a previous
one, and keeps priming the head and the tail. It also stops waiting on
itself: the media service worker installs while the reader opens, and
priming starts as soon as the reader is open rather than once the worker
controls the page. Errors surface in the same order as before.

Against the live network, ten alternating rounds in fresh Chromium contexts
with the same 54.9 MB video gave a median first frame of 6.6 s against
9.1 s, faster in 7 of 10 pairs; one baseline sample failed to load. Two
later batches kept the plain reader ahead by less, 7.8 s against 9.7 s and
then 8.8 s against 9.2 s: the first frame mostly waits for the first
record's own fetch, which varied from 4 to 11 s, so the competing fetches
cost less than the first batch suggested. Seeking to the middle after ten
seconds of playback was slower in the first batch, median 6.5 s against
3.4 s, and faster in a later one, 2.8 s against 5.1 s, so no seek
difference is claimed. A fourth batch, with the `ccd4106` core, showed no
first-frame gain either, 6.1 s against 5.6 s over 12 rounds, so none is
claimed for the reader mode. The plain reader is kept because it does no
worse, fetches less ahead of the player, and is what try.autonomi.com's
player uses: with this change the SDK started the video as soon as that
player, a median 4.5 s against 4.1 s over 20 rounds, doing the same network
work.

The page also messages the worker every 10 s while a media source is open,
because Firefox stops a worker that has had no new event for 30 s even while
it answers a request. The worker waits up to 120 s for a block, beyond the
core's retries of a missing record after 15 and 45 s, and marks its
responses `nosniff` and sandboxed, since their type comes from the file's
metadata. No core or wire change. Evidence is in the
[2026-10-22 audit](../audits/2026-10-22-media-first-frame.md) and the
[2026-10-26 comparison with try.autonomi.com](../audits/2026-10-26-sdk-vs-try-streaming.md).
