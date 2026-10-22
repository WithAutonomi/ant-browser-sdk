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

Expose typed pointer address, read, resolve, create, update, transfer, finality and recovery methods. Counters remain decimal strings and all five finality states are preserved. Require applications to durably persist each opaque checkpoint through onCheckpoint. The first checkpoint is the payment intent (signed state, original payment plan, quotes and network identity), persisted immediately before the wallet is invoked, so every durable checkpoint may have a payment. Later checkpoints add broadcast evidence and, only once Rust has accepted a receipt for the plan, the receipt with the paid record and proof (base64). A rejected receipt is never journaled as one; its transaction hashes are kept as evidence. Never journal the owner seed. Each checkpoint is a complete state; calls are serialized and states produced during a call are coalesced into the next.

A wallet awaits `PaymentContext.submitted()` before observing its receipt, as the core's wallets await `onSubmission`: it settles once the broadcast evidence is durable, in the pointer checkpoint or the core's upload journal, or after at most 30 seconds, and never rejects. The bundled Ethers and Wagmi providers do so. The page therefore keeps the transaction before anything waits on its confirmation, and a slow or failed journal write never stops the wallet observing a transaction already broadcast.

PointerError carries a checkpoint exactly when the wallet may have been asked to pay; without one, no payment was requested and a fresh write is safe. After payment, persistence failures and timeouts do not stop Rust from storing the paid state, and a write the network stored resolves. Resume and in-page recovery only observe the original transaction (first through the submission's wait() observer on the same page, then PaymentProvider.recover) or store an existing paid state; they never invoke PaymentProvider.pay. Cancellation before submission stops payment; after submission settlement and paid-proof storage continue, and client.close() keeps the transport open for that write only. Applications retain checkpoints until they have confirmed the desired state, and serialize writes for each owner. Transfer is permanent and callers must inspect finality.

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

Test malformed manifests, canonical round trips, pending and paid recovery, callback failures, wallets waiting for broadcast evidence to be journaled, network mismatches, cancellation and real-browser paid pointer writes and streaming saves. Record exact revisions and limitations in a dated audit. Human engineering review is required.

## Notes for AI-assisted work

This ADR remains Proposed until human engineering review.
