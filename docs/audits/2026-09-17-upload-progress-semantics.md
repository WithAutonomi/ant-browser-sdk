# Upload progress semantics correction — 2026-09-17

Supersedes the quote/store semantics in [the initial progress audit](2026-09-17-transfer-progress.md).

## Cause and correction

The original vault mapping counted Merkle existing-storage preflight callbacks
as completed payment quotes, before candidate-pool collection began. It also
presented the aggregate stored callback (which includes already-present chunks)
as newly stored chunks. Neither counter established a new unpaid write.

The core now emits separate existing-storage checks and already-present record
identities. Real record quote events follow completed payment preparation.
Merkle candidate-pool collection reports current-batch progress, and preparation
boundaries explain the remaining work. A new per-record write callback runs only
after a successful store; the vault counts unique write identities instead of
subtracting preflight results from an aggregate that can lag a prefetched wave.
The SDK reports Merkle payment waiting, confirmation, and confirmed receipt reuse.
Native adapters keep their existing aggregate progress callback; added hooks have
default no-op implementations. Payment, quorum, and verification rules are unchanged.

## Artifact

- Core commit: `7e3e891cc5a73fcad6ffcd6aa0bb2aee63e623bc`; clean tracked sources: `True`.
- SDK source base: `8189aa2` plus the SDK progress correction in this change.
- WASM SHA-256: `4b9b74652ede588424e97bfc4474e80a9415e1fe8fadad514abd70c51124a7c0`.

## Validation

- Core native library suite: 696 tests passed.
- SDK `npm run check`: typecheck and 158 tests passed; the Merkle recovery test
  now checks waiting/confirmation/reused-payment phase events.
- Vault unit tests: 44 passed, including preflight completion with zero actual
  quotes, existing records with zero new writes, duplicate and out-of-order
  record identities, and prefetched existing chunks that must not erase writes.
- Vault production build: passed.
- Production browser suite: four passed, one existing wallet test skipped.

No new paid live upload was attempted. Actual network latency and a complete
real-network transfer were not validated; the earlier live probe timed out.
This fixes misleading telemetry and exposes remaining quote preparation work;
it does not claim to reduce network lookup or quote-collection time.
