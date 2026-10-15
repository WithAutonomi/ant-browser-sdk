# ADR-0009: Typed pointers and durable payment recovery

- **Status:** Proposed
- **Date:** 2026-10-15
- **Decision owners:** Mick
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0005; ADR-0007; ant-client ADR-0007

## Context

Browser applications need shared-core manifest exports and pointer operations with recoverable payments. Losing a page after broadcast must not authorize another payment.

## Decision Drivers

- Keep protocol validation and payment proofs in Rust.
- Retain durable evidence across failures and cancellation.
- Preserve compatibility with existing readers and wallet adapters.

## Considered Options

1. Expose raw bindings and leave each application to reconstruct the protocol.
2. Persist only paid proofs, leaving broadcast-to-confirmation failures unresolved.
3. Typed wrappers and pre-payment checkpoints with observation-only recovery (chosen).

## Decision

Expose typed pointer address, read, resolve, create, update, transfer, finality and recovery methods. Counters remain decimal strings and all five finality states are preserved. Require applications to durably persist each opaque checkpoint through onCheckpoint before payment starts. Journal the signed state, original payment plan, network identity, submissions, receipt and paid proof, never the owner seed. Resume only observes the original transaction or stores its existing paid state; it never invokes PaymentProvider.pay. Cancellation before submission stops payment; after submission settlement and paid-proof persistence continue. Applications retain checkpoints until they have confirmed the desired state, and serialize writes for each owner. Transfer is permanent and callers must inspect finality.

## Consequences

### Positive

- Applications can recover interrupted writes without an automatic second payment.
- Native and browser formats and pointer policy remain shared.

### Negative / Trade-offs

- Applications must supply durable persistence and an observation-only recovery provider for unresolved payments. A crash before submission may require explicit verification that nothing was broadcast.
- Checkpoints contain signed records and transaction evidence and must be treated as sensitive application data.

### Neutral / Operational

- Additive APIs; no network protocol change. New checkpoint schemas are versioned.
- SDK releases require the companion Rust changes on ant-client main.

## Validation

Test malformed manifests, canonical round trips, pending and paid recovery, callback failures, network mismatches, cancellation and real-browser paid pointer writes and streaming saves. Record exact revisions and limitations in a dated audit. Human engineering review is required.

## Notes for AI-assisted work

This ADR remains Proposed until human engineering review.
