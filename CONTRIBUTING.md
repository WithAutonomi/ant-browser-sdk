# Contributing

Read [AGENTS.md](AGENTS.md) for the repository's shared engineering instructions.

Use Node.js 20.19 or newer and run `npm run check` before submitting a change.
Public APIs must remain typed, browser capabilities must be feature-detected, and
untrusted protocol data must continue to be validated by the shared Rust/WASM core.

When changing the Rust boundary, refresh the checked-in artifact with
`ANT_CLIENT_DIR=/path/to/ant-client-web-support npm run sync:wasm` (the sibling
web-support worktree is the default), update the TypeScript types,
and test both the SDK and the real-browser demo against a browser-enabled devnet.

Commit the generated `src/wasm` bindings, binary, and `source.json` together.
The provenance file records the source revision and binary checksum. Run
`npm run build:examples` and `npm pack --dry-run` to check the shipped assets.

## Architecture decisions

Inspect [docs/adr/](docs/adr/) before changing architecture, public APIs, protocols,
storage, cryptography, payment behavior, or operational invariants. Draft decisions
with the [ADR template](docs/adr/TEMPLATE.md) and start them as `Proposed`.
Acceptance requires human engineering review. Accepted ADRs are immutable; create
a new superseding ADR instead. Dated reports in `docs/audits/` provide evidence
and do not replace architecture decisions.

Run `python3 scripts/adr-governance.py` to check ADR governance. Reviewers must also
assess the reasoning, alternatives, evidence, and consequences.

## Pull requests

Fill every field in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
Include a closing Linear reference such as `Closes V2-123`, exactly one risk tier,
exactly one Semver impact, compatibility notes, test evidence, dependencies, and
mitigation or rollback. Tier 2/3 changes require an ADR link. A human confirms the
proposed risk tier and Semver impact and acknowledges new dependencies in review.

The shared PR checks run in CI. Validate changes to them locally with
`python3 .github/scripts/test_check_pr.py`.

## License

This project uses `MIT OR Apache-2.0`, matching `ant-client`. Preserve the existing
notices in [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE); both are
included in the published npm package.
