# ADR-0008: Large-file downloads and writable streams

- **Status:** Proposed
- **Date:** 2026-10-15
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0003; ADR-0007; ant-client ADR-0004 large-file download destinations

## Context

ant-client main supports 64-bit file positions, bounded plaintext decryption,
direct writable destinations, cancellable downloads and shared in-flight GETs.
The SDK still caps media at 1 GB and does not expose the new download options
or writable pipeline. Its existing download result includes both bytes and a
Blob, so changing that method to return only disk metadata would break callers.

## Decision Drivers

- Support files beyond 1 GB and seeks beyond 4 GiB without whole-file buffering.
- Preserve Rust ownership of integrity, scheduling, decryption and read policy.
- Preserve existing download results, upload/payment behavior and error codes.
- Make cancellation, destination ownership and memory limits explicit.

## Considered Options

1. Remove only the media limit. This leaves disk downloads using file-sized buffers.
2. Change downloadAndSave to return disk-only results. This breaks its byte/Blob API.
3. Expose the core's pipeTo on the existing reader and retain buffered methods.

## Decision

Choose option 3. `PublicFileReader.pipeTo(writable, options)` accepts public,
private and manifest-backed readers, an optional half-open byte range,
AbortSignal and byte-progress callback. It returns the bytes written and their
BLAKE3 hash. The core fetches concurrently, writes in order with backpressure,
and holds up to 32 MiB of pipeline plaintext; the resident map/index, shared
chunk cache and transport reservations are additional memory. Each write is
at most 4 MiB. Concurrent reads share in-flight GETs through the core.

The core closes the destination on success, aborts on transfer failure, and
releases the writer lock. Invalid calls leave the destination untouched.
Cancellation during destination close can reject after the data is committed.
Closing a reader cancels its active pipes. The SDK defers freeing the WASM
reader until raw calls settle, including cancelled range calls.

`download({ maxMemoryBytes, signal })` forwards both options to Rust. The budget
limits the output Uint8Array, not total process memory; the Blob snapshot and
core resources remain additional allocations. downloadAndSave keeps its existing
buffered return value. Applications use pipeTo for large disk downloads; the
all-in-one example demonstrates this with an explicit picker and cancel button.

Media and service-worker positions accept safe JavaScript integers through
Number.MAX_SAFE_INTEGER. Uploads remain limited by upstream to 1,000,000,000
bytes. SDK_LIMITS.maxFileBytes retains that upload limit for compatibility;
maxUploadBytes names it explicitly. No network, DataMap or payment format changes.

## Consequences

### Positive

- Large files can be saved and played with bounded content buffering.
- Existing buffered consumers remain compatible.
- Verified fetching and backpressure use one shared core implementation.

### Negative / Trade-offs

- The destination must be a WritableStream; browser file-picker support varies.
- The resolved map/index still grows with chunk count. Large JS allocations,
  destination quota and browser limits can fail below the safe-integer ceiling.
- Buffered downloads still need memory proportional to file size.

### Neutral / Operational

- Regenerate bindings, binary, provenance and notices together from clean main.
- Deploy the updated media service worker alongside the SDK.
- No new npm dependency. Rust dependency changes are recorded in generated notices.

## Validation

Run SDK checks, production-WASM tests, example builds, package/provenance checks
and governance. Verify real Chromium against isolated compatible WebRTC nodes:
public/private uploads, manifest reads, disk output, cancellation, media ranges,
and a native-produced file larger than 4 GiB with matching size and BLAKE3.
Record exact revisions and limitations in a dated audit. A compressible large
fixture validates correctness, not representative network throughput.

## Notes for AI-assisted work

This ADR remains Proposed pending human review. Accepted ADRs are immutable.
