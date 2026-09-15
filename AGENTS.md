# Repository guidance

## Project overview

`@withautonomi/browser-sdk` is an ESM TypeScript SDK for direct browser access to
Autonomi nodes over WebRTC. It bundles the shared Rust `ant-core` WASM artifact.

- `src/`: public client, types, wallet adapters, and browser lifecycle code.
- `src/internal/`: staging, persistence, payment recovery, and runtime adapters.
- `src/wasm/`: checked-in generated bindings, binary, and provenance.
- `public/autonomi-stream-sw.js`: service worker for media streaming.
- `examples/`: five Vite applications exercising the SDK and wallet adapters.
- `test/`: Vitest tests, including the production WASM boundary and public types.
- `docs/adr/`: architecture decisions; `docs/audits/`: dated validation evidence.

Read `CONTRIBUTING.md` for the contributor workflow and `README.md` for the public
API and architecture boundaries.

## Development and validation

Use Node.js 20.19 or newer.

```bash
npm ci
npm run check              # Build, TypeScript checks, and tests
npm run build:examples     # Build all five applications
npm pack --dry-run         # Run prepack checks and inspect shipped assets
python3 scripts/adr-governance.py
python3 .github/scripts/test_check_pr.py
```

Run checks appropriate to the change. Run build and pack commands sequentially:
the build recreates `dist/`. Do not hand-edit generated `dist/` output.

## Architecture and code standards

- Keep public APIs typed, use options objects, and preserve stable SDK error codes.
- Keep application UI and wallet policy in applications. Report progress through
  callbacks and support `AbortSignal` for long-running operations.
- Feature-detect browser capabilities and clean up workers, sessions, object URLs,
  readers, and storage resources throughout success, failure, and cancellation.
- Keep protocol validation, cryptography, quote verification, payment planning,
  storage proofs, and network policy in the shared Rust core. Do not add browser
  bypasses for payment or integrity checks.
- Preserve durable payment checkpoints and confirmed proofs. A timeout or rejected
  callback is not proof that a transaction failed or was never submitted.
- Keep Ethers and Wagmi/Viem integrations optional and outside the core entry point.
- Update public documentation and examples when changing public behavior.

## Rust/WASM boundary

Rebuild from the shared client checkout with
`ANT_CLIENT_DIR=/path/to/ant-client-web-support npm run sync:wasm`; the sibling
`../ant-client-web-support` worktree is the default. Follow that checkout's own
instructions when editing Rust.

Commit the generated bindings, binary, and `src/wasm/source.json` together. Record
the exact source revision and checksums; use a clean source checkout for release
artifacts. Do not manually patch generated bindings or infer native/browser parity
from helper tests alone.

For Rust boundary changes, run the SDK checks and the real-browser demo against a
compatible browser-enabled devnet. Record exact SDK, WASM, and node revisions,
commands, outcomes, and limitations in `docs/audits/`. Keep dated audits historical;
link newer evidence when earlier findings are superseded.

Use isolated local test processes and ports. Only stop processes started for the
task; never use broad process-kill commands or disturb sibling repositories' nodes.

## Architecture Decision Records

Before changing architecture, protocols, storage formats, crypto, network
behaviour, public APIs, data models, or operational invariants, inspect `docs/adr/`.
If a change creates or changes an architectural decision, draft or update a
Proposed ADR using `docs/adr/TEMPLATE.md`.

- New ADRs start as `Proposed`; use the next free four-digit number, checking the
  target branch as well as the working branch.
- Never edit an Accepted ADR, including its metadata. Create a superseding ADR
  and reference the earlier decision from the new record.
- Never mark an ADR Accepted autonomously; human engineering review and debate
  are required.
- Review correctness, alternatives, evidence, consequences, and compliance with
  accepted decisions. Passing the format check alone is insufficient.

## Pull requests

Use `.github/PULL_REQUEST_TEMPLATE.md` and fill every field. If a required value
cannot be determined, ask before opening the PR; do not invent an issue or evidence.

- Link the Linear issue in its section with a closing form such as `Closes V2-123`.
- Check exactly one risk tier and exactly one Semver impact. Propose these from the
  change; a human confirms them during review.
- State wire, storage, and API compatibility impact explicitly, or write `none`.
- Link an ADR for Tier 2/3 and include the corresponding test evidence.
- List new dependencies for human acknowledgement during review and describe
  mitigation or rollback.

The `linear-link` and `pr-template` CI jobs validate these fields. Keep the shared
PR checker, its tests, and its workflow aligned with the WithAutonomi repositories.

## Licensing

The SDK is dual-licensed under `MIT OR Apache-2.0`. Preserve both root license
files and the existing copyright notices, keep package metadata consistent, and
include both licenses in the npm package.
