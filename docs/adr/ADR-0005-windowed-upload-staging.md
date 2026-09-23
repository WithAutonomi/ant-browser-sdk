# ADR-0005: Stage File and Blob uploads in storage-bounded windows

- **Status:** Proposed
- **Date:** 2026-09-23
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0004 draft (regenerate upload records on demand; not yet
  committed or reviewed); ant-client ADR-0004 amendment "Record batches and
  private DataMaps (2026-09-23)"; `BrowserNetworkClient.uploadRecords`;
  `src/upload-worker.js`; `src/internal/window-stager.ts`;
  `src/internal/upload-sources.ts`; `src/internal/window-checkpoint.ts`

## Context

`File` and `Blob` uploads self-encrypted the whole input in a worker, stored every
encrypted record in IndexedDB, and only then asked the Rust coordinator to quote,
pay for, and store the records. The upload required free quota of about the file
size plus five percent plus 16 MiB before any network work started. Files that fit
on disk were refused when the origin's quota was smaller, most often on Safari, in
private browsing modes, and on devices with little free space.

The shared coordinator's `upload_records` call has two properties that constrain
any change:

- It preflights every record of the call, verifying its bytes against its
  address, before any payment.
- It stores Merkle-paid records in an unordered fan-out and single-node-paid
  records in waves, so it needs random access to every record of the call.

Self-encryption streams records in a fixed order: data chunks 2 to n-1, then
chunks 0 and 1 once all source hashes are known, then nested DataMap records, then
the DataMap record. A record's address is known only once it is produced.

## Decision Drivers

- Upload files up to `SDK_LIMITS.maxFileBytes` when the origin's quota is smaller
  than their ciphertext.
- Bound IndexedDB use by the available quota, not by the file size.
- Keep self-encryption, content addressing, quote verification, payment policy,
  and storage in the shared Rust core, without changing `self_encryption`.
- Keep behavior, checkpoints, and cost unchanged for files that already fit.
- Preserve durable payment journals, confirmed proofs, and explicit resume.

## Considered Options

1. **Keep whole-file staging.** No change; the quota ceiling remains.
2. **Regenerate records on demand** (the ADR-0004 draft). Removes IndexedDB from
   the upload path, but needs a public chunk-level `self_encryption` API, a
   coordinated release of three repositories, and up to three encryption passes.
3. **Stage windows, one payment batch per window.** Encrypt once, stage as many
   records as the quota allows, and upload each window as its own coordinator
   call.
4. **Stage windows under one payment for the whole file.** Pay from a manifest
   gathered by a first encryption pass, then stream windows of bytes. Rejected: it
   needs two encryption passes, breaks the coordinator's preflight-before-payment
   and random-access storage within one call, and single-node proofs can expire
   before late windows are re-encrypted.

## Decision

We will adopt option 3.

### Shared Rust boundary

`BrowserNetworkClient.uploadRecords(batch, ...)` uploads one batch of
caller-staged, content-addressed records through the shared coordinator with the
existing wallet, progress, checkpoint, and payment-mode arguments. A batch carries
its first record's position in the file and, when known, the file's record count;
these only keep progress messages in file-level positions. Every upload result
reports the payment mode the coordinator used. Rust still verifies each record
against its address whenever it is loaded.

### Windows

The upload worker keeps the native streaming encryptor open for the whole upload.
For each window the SDK estimates the budget as the remaining quota minus a 16 MiB
reserve, divided by 1.05 for IndexedDB overhead. The worker stages records until
the next one would exceed the budget, or until IndexedDB reports
`QuotaExceededError`, and holds that record back in memory to open the next
window, so every record is encrypted once. A window must fit at least one record
(4 MiB at most). The SDK uploads the window as one batch, then deletes its records
before the worker continues. When the browser offers no estimate, a window is
unbounded until IndexedDB refuses a write.

A file that fits is staged and uploaded as a single window, with the same record
list and therefore the same Rust checkpoint scope as before.

### Payments

Each window is a separate coordinator call and payment batch. The requested
`paymentMode` applies to each window with the native threshold and fallback rules:
`auto` uses Merkle payment for windows of at least 64 unique unpaid records.
`UploadResult.paymentMode` is `merkle` when any window used a Merkle batch.

### Checkpoints and recovery

A Rust checkpoint's scope is its call's record list, so each window of a
multi-window upload has its own checkpoint. Persisted checkpoints wrap it in an
SDK envelope naming the window's first record and record count. Passing an
envelope to `upload()` makes the worker re-encrypt and discard the records before
the window, stage exactly that window again, and continue with ordinary windows.
Earlier windows completed before the envelope was written. A plain Rust checkpoint
covers the whole file, which is then staged as one window regardless of the
budget. `reconcileFailedUploadPayment` unwraps an envelope and returns the same
form.

After failure or cancellation the recovery retains the `File` or `Blob`, the
staging cursor, and the window being uploaded, which stays in IndexedDB. Completed
windows are already deleted. Resume uploads the retained window again, then starts
a new worker that re-encrypts up to the next unstaged record. A partially staged
window is deleted when staging fails. Discard and completion delete the session.

## Consequences

### Positive

- Uploads no longer need quota for the whole ciphertext; one record suffices.
- IndexedDB holds at most one window, including for retained failures.
- Each attempt encrypts each record once, off the main thread.
- No change to self-encryption, record formats, or the wire protocol.
- Files that fit keep one payment batch and their existing checkpoints.

### Negative / Trade-offs

- A multi-window upload makes a separate payment per window: more wallet
  transactions and approvals, and more gas. Merkle trees are padded per window, so
  they can bill more leaves than one tree over the whole file. `auto` may choose
  single-node payment for a small window where native would choose Merkle for the
  whole file.
- Resuming a multi-window upload re-encrypts the file up to the retained position.
- The checkpoint envelope is an SDK format. A restarted upload must stage exactly
  the recorded window, which must fit the quota at that time.
- Staging a window and uploading it do not overlap.
- Records of a window retained across a page reload stay in IndexedDB, as whole
  retained files did before; the leak is now bounded by one window.
- Every attempt still requests persistent storage, which Firefox may prompt for.
- Windowing needs the browser to reuse the space of deleted records. Chromium
  on-disk profiles did so at once; incognito profiles keep IndexedDB in memory
  and did not within two minutes, so a file larger than their quota fails after
  its first window, with that window paid and the upload retained.

### Neutral / Operational

- No wire, protocol, DataMap, or stored-record format changes.
- `uploadRecords` is additive; `uploadPublicFile` and `uploadStagedPublicFile`
  remain in the core but are no longer used by the SDK.
- The in-memory `Uint8Array` path uploads all records as one batch, as before.

## Validation

- Unit tests for the window stager: byte budgets, early quota exhaustion,
  held-back records, empty-window rejection, and exact restored windows.
- Staging session tests for worker start options, one window at a time,
  cancellation, and worker errors; budget tests for the quota formula.
- Integration tests through `client.upload()`: consecutive paid windows, plain
  checkpoints for single windows, envelopes per window, Merkle reporting, resume
  from a retained window, restart from an envelope, plain-checkpoint restaging,
  partial staging cleanup, and envelope reconciliation.
- ant-core WASM tests: consecutive batches downloading as one file, file-level
  progress positions, reported payment modes, and batch validation.
- A real-browser run with a quota smaller than the file, recorded in
  [the 2026-09-23 audit](../audits/2026-09-23-windowed-private-uploads.md) with SDK,
  WASM, and node revisions, covering quota-error and estimate-bounded windows,
  Merkle windows, resume, and the incognito limitation.
- Review triggers: changes to the coordinator's preflight or storage order that
  would allow one payment across windows, a random-access self-encryption API
  (the ADR-0004 option), or browser quota API changes.

## Notes for AI-assisted work

AI tools may help draft this ADR, but **must not mark it Accepted without human review**. Accepted ADRs are immutable: create a new superseding ADR rather than editing an Accepted ADR.
