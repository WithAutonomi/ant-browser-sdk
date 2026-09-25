# ADR-0002: Shared network defaults for browser connections

- **Status:** Proposed
- **Date:** 2026-09-15
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** Native ant-client configuration; shared ant-core WASM boundary

## Context

Developers currently supply a WebRTC Direct address to `connect()` or supply
trusted seeds and payment identity to `connectNetwork(profile)`. There is no
bundled mainnet profile. Payment RPC configuration belongs to the application
or wallet. This makes every application assemble deployment defaults itself.

Native clients already distribute defaults, although they do not discover their
initial trust anchors automatically:

- `ant-client/resources/bootstrap_peers.toml` ships in CLI release archives;
  `install.sh` installs it in the platform configuration directory.
- Native bootstrap selection prefers explicit peers, then a devnet manifest,
  then that configuration file. The shared web-support checkout implements this
  in `ant-core/src/config.rs`; an unusable selected manifest fails without
  falling back to public peers.
- `evmlib::Network` defaults to Arbitrum One and supplies known token/vault
  addresses and a public RPC URL. Applications can select a custom network.
- Native clients also have a persistent peer cache. That optimization is
  separate from distributing initial trusted seeds.

Source inspection used ant-client revision
`81a0a2470ea74fa8608ed60c8ff214ff1fe2fc3d`, ant-client-web-support revision
`2b0aa662ba54f1c0b2b263251c6bda8a88e08ba2` (the SDK's recorded WASM source),
and evmlib-web-support revision `cf424c0447c9f1ca1313b43ce07df65a227e340c`.
These are code observations, not evidence of live mainnet browser availability.

Native bootstrap socket addresses cannot be converted into browser trust
anchors: WebRTC Direct needs the actual listener address, certificate hash,
and peer identity. The inspected bootstrap resource contains only native
socket addresses. Rust's native `config` module also uses filesystem APIs and
is excluded from the WASM build.

## Decision Drivers

- Make ordinary mainnet use possible without manually collecting endpoints.
- Keep canonical network identity and validation in shared Rust code.
- Preserve explicit application and wallet configuration.
- Prevent custom/devnet failures from silently selecting mainnet.
- Keep network connection and downloads independent of payment RPC access.

## Considered Options

1. Continue requiring each application to supply every default.
2. Hard-code separate bootstrap and EVM defaults in TypeScript.
3. Distribute browser seeds with the shared client and expose shared network
   defaults through WASM, with browser-specific adapters in the SDK.
4. Fetch all defaults from a remote configuration service at connection time.

## Decision

We propose option 3. The initial implementation provides the configuration
foundation with an empty mainnet WebRTC seed list; it does not claim live mainnet
browser availability.

### Shared configuration and distribution

Introduce a platform-independent network-profile resolver in ant-core. Reuse
evmlib's payment-network definitions instead of duplicating contract addresses
or public RPC defaults in TypeScript. Expose the resolved identity, default RPC,
and browser seeds through WASM. Native filesystem loading remains a native
adapter around shared configuration rather than a browser dependency.

Maintain one reviewed resource, `ant-core/resources/bootstrap_peers.toml`,
with separate `quic` and `webrtc` multiaddress arrays. Native release packaging
ships this file. WASM exposes only WebRTC seeds. The WebRTC list starts empty;
adding verified endpoints and rebuilding the artifact activates defaults. A named profile binds those seeds to the expected payment
chain and both payment contracts. Transport-specific seeds remain distinct;
sharing a payment chain alone does not establish a storage network's identity.

Do not invent certificate hashes, infer listener ports from native addresses,
or adopt node-advertised RPC URLs. Release owners must provide verified seed
metadata and operate certificate rotation with an overlap period for published
SDK versions. Initial delivery uses versioned package releases. A remotely
updated bootstrap document would require a separate decision about publisher
authentication, expiry, rollback protection, and availability.

### SDK connection behavior

Provide an additive options-object connection form, conceptually:

```ts
const client = await AutonomiClient.connect(); // bundled mainnet profile
const paidClient = await AutonomiClient.connect({ payment });
```

Keep the existing `connect(multiaddr, options)` and
`connectNetwork(profile, options)` forms working. `connect({ network, ...options })` accepts `"mainnet"` or an
application-owned profile. `getNetworkDefaults({ wasm, signal })` reads the
frozen mainnet defaults, including `rpcUrl`, without dialing. Empty seed lists
can be inspected but connection fails with `CONNECTION_FAILED`. Custom profiles
require at least one distinct seed.

An omitted network selects the bundled mainnet profile. An explicit custom
profile is authoritative and must supply its own seeds and payment identity.
Applications overriding mainnet seeds can copy `getNetworkDefaults()` into a
custom profile, retaining its expected payment identity. Invalid or unreachable custom configuration never falls back to
mainnet. Failover stays within the selected profile, supports cancellation,
and cleans up unsuccessful sessions. Bootstrap authentication runs inside the
Rust network client's pool with at most four concurrent seed attempts. The first
seed passing authentication, capability and expected-payment checks establishes
the SDK connection; other attempts continue within the same pool. Normal SDK
startup no longer creates and discards a standalone `BrowserNodeClient` probe.
Closing during startup closes all pooled attempts immediately and releases the
WASM allocation after its pending async call settles.

The bundled production WASM exposes `BrowserNetworkClient` as its only networking
client. Remove the old `BrowserNodeClient` and `BrowserNodeSession` exports;
per-node transport test helpers remain behind the core's `test-utils` feature.
Single-node HELLO diagnostics can use a one-seed network client. There is no
current SDK requirement for exact-replica RPCs or a separate connection owner.
Direct users of the removed WASM exports must migrate; the high-level SDK
connection overloads remain compatible.

Named connections verify the authenticated HELLO against the profile's payment
identity before use; a mismatch keeps the existing `NETWORK_MISMATCH` behavior.
Peer discovery continues through the shared Rust network implementation.
Persistent browser peer caching is deferred to a separate storage decision.

### Payment provider behavior

Expose the shared default RPC through `getNetworkDefaults()` for applications
constructing Ethers providers or Wagmi public-client transports. Existing
payment-adapter behavior stays unchanged in this foundation: private-key
adapters require `rpcUrl`, injected signers use their own provider, and Wagmi
uses the application's config. No wallet configuration is mutated and no RPC
is inferred from untrusted HELLO metadata. The application still owns wallet
selection, consent, and chain switching.

Keep provider chain checks, Rust payment validation, and durable payment
recovery. Bootstrap nodes do not advertise RPC URLs, and connecting or
reading files never contacts an EVM RPC. Automatically choosing an adapter RPC
can be considered separately once the deployment defaults are available.

## Consequences

### Positive

- Mainnet applications can connect without copying bootstrap or RPC constants.
- Native and browser payment defaults have one source of truth.
- Explicit configuration and existing APIs remain available.

### Negative / Trade-offs

- Public WebRTC seed publication and certificate rotation become release
  responsibilities instead of obligations for every application developer.
- Bundled endpoints age; public RPC availability, CORS, and rate limits require
  browser validation and an application override path.
- The change spans shared Rust, generated WASM artifacts, the SDK, and examples.

### Neutral / Operational

- No wire-protocol or persisted-storage change is proposed. SDK APIs gain
  additive defaults and helpers; existing explicit connection behavior remains.
  Removing the standalone low-level WASM node exports is a breaking API change
  for their direct consumers.
- No new package is added. Existing Rust TOML parsing becomes portable so the
  same bundled resource is read on native and WASM targets.
- Keep explicit connections available as a rollback path. Do not ship a working
  mainnet-default claim until verified production browser seeds are available.

## Validation

Implementation must test default selection, explicit override precedence,
custom-profile isolation, seed failover, cancellation, resource cleanup, HELLO
identity mismatch, RPC chain mismatch, and unchanged wallet-provider selection.
Verify that connections/downloads issue no EVM RPC requests and that shared
network values reach the real WASM boundary without divergent TS constants.

Run SDK checks, all example builds, package inspection, and ADR governance.
Rebuild WASM from a clean shared checkout and commit bindings, binary, and
provenance together. Run the real-browser demo against a compatible isolated
devnet and record exact SDK, WASM, and node revisions in a dated audit.
Separately validate published mainnet seeds and browser access to the default
RPC before enabling the default mainnet experience. See [the implementation audit](../audits/2026-09-15-network-defaults.md) for
validation outcomes and current limitations.

## Notes for AI-assisted work

This ADR remains Proposed pending human engineering review. Accepted ADRs are
immutable; create a superseding record for subsequent architectural changes.
