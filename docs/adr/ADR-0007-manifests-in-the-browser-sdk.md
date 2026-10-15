# ADR-0007: Manifests and `ant://` links in the browser SDK

- **Status:** Proposed
- **Date:** 2026-10-06
- **Decision owners:** Mick
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ant-client ADR-0006 (file manifests and manifest links);
  ADR-0006 (private uploads keep the DataMap with its holder);
  `parseManifestLink` and `decodeManifest` exports of ant-core's browser build

## Context

ant-client ADR-0006 defines a manifest: a versioned msgpack document listing
files with optional paths, where each entry carries an embedded DataMap or the
address of a public DataMap chunk. Manifests are shared off the network as
`.ant` files or `ant://manifest/<base64url>` links, and `ant://<address>` is a
plain file link. The ant CLI writes a manifest for every upload.

Browser applications receive such links and files from users and need to read
the files they describe. The SDK already reads a public file by address and a
private file by caller-held DataMap bytes. An embedded manifest entry is
exactly the latter, and a public entry exactly the former.

## Decision Drivers

- Decoding and validation of the format stay in the shared Rust core, which
  already exports them for the browser build; the SDK adds no parser.
- Nothing is fetched to decode a manifest or a link.
- An entry is read through the existing download, reader and media APIs so
  applications need no new read path.
- Public API stays typed and frozen, with stable error codes.

## Considered Options

1. **Parse manifests in TypeScript.** Rejected: a second implementation of the
   format and its path rules would drift from the core.
2. **Expose only raw bindings.** Rejected: applications would re-derive the
   mapping from entry to download source and its edge cases.
3. **Typed wrappers over the core exports plus entry acceptance in the read
   APIs (chosen).**

## Decision

The SDK exports `parseManifestLink(link)` and `decodeManifest(bytes)`, both
asynchronous because they initialise the WASM module, returning frozen
`ManifestLink` and `Manifest` values whose entries carry `name`, optional
`path` and `size`, optional `knownSize`, `kind`, hex `address`, and for embedded entries the
canonical DataMap bytes; a manifest also exposes the torrent info hashes its
creator recorded, as hex, which the SDK only surfaces. Failures carry the
`INVALID_SOURCE` code.

The core derives an embedded entry's address by hashing its published DataMap
form, so a root map and its shrunk map identify the same file. `knownSize` is
derived from a root map's chunk lengths; it is absent for public references and
shrunk maps. It is separate from the creator's unverified `size` hint, and is
not used to bypass verification by downloads or readers. `.ant` files may embed
roots while links carry the published form to bound their length.

`client.download`, `client.downloadAndSave`, `client.openFile` and
`client.createMediaSource` accept a `ManifestEntry`. An embedded entry is read
as a private file reference whose name is the entry's last path component; a
public entry is read by its address. `manifestEntrySource`, `manifestFileName`
and `isManifestEntry` expose that mapping. Entry `size` is never used for
anything but display. No extraction to a filesystem is added: the browser has
none, and applications own how files are saved.

## Consequences

### Positive

- One link or file gives an application a typed list of files it can stream
  or download with the APIs it already uses.
- Embedded entries skip the DataMap fetch; measured on mainnet, that fetch
  was 4 to 5 s of an 11.6 s median open time for a 612 MB file.

### Negative / Trade-offs

- The SDK's WASM must be synced from an ant-client revision that exports the
  manifest functions; older builds lack them.
- The finalized v1 layout uses packed chunk records owned by the manifest
  format. Draft links and files using self-encryption's serde layout must be
  regenerated with the current CLI; the core rejects them.
- Manifest links are long; the SDK does not shorten or publish them.

### Neutral / Operational

- No wire, storage or payment change. The additions are additive public API.

## Validation

- Vitest against the shipped WASM: a mainnet-built link decodes to its entry
  with 320 DataMap bytes, file links and bare addresses parse, decorated file
  links and malformed payloads are rejected with `INVALID_SOURCE`, bytes
  missing the header are rejected.
- The ant-client golden v1 fixture decodes with the root map's derived size
  exposed as `knownSize`, distinct from the creator's `size` on a public entry.
  Draft DataMap layouts and unsupported format versions reject with
  `INVALID_SOURCE`.
- Client tests: an embedded entry routes to the private download and reader
  with the entry's file name and no public DataMap fetch; a public entry
  routes to the public download; an embedded entry without DataMap bytes is
  rejected.
- Acceptance requires human engineering review.
- [Main sync audit](../audits/2026-10-08-ant-client-main-sync.md): production
  WASM, SDK checks and real Chromium demo against the pinned browser devnet.
