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
`path` and `size`, optional `knownSize`, optional hex `sha256`, `kind`, hex
`address`, and for embedded entries the canonical DataMap bytes; a manifest
also exposes the torrent info hashes its creator recorded, as hex, which the
SDK only surfaces. Failures carry the `INVALID_SOURCE` code.

`sha256` is the creator's whole-file hash of the plaintext (ant-client
ADR-0006), which the CLI checks when extracting. `download()` and
`downloadAndSave()` check it too, before returning or saving the bytes, and
fail with `DOWNLOAD_FAILED` on a mismatch; a malformed `sha256` is refused with
`INVALID_SOURCE` before anything is fetched. The bytes are already whole there,
and the core's browser build exports no SHA-256, so WebCrypto hashes them,
before the result's Blob copies them so the check does not raise peak memory.
This is a check of the creator's claim, not of integrity, which the core still
verifies by content address. Without WebCrypto, outside a secure context, such
an entry fails to download rather than arriving unchecked. `streamAndSave()`,
`openFile()` and `createMediaSource()` never hold the whole file and WebCrypto
cannot hash incrementally, so they do not check it.

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


`createManifest(input)` also creates canonical `.ant` bytes, the normalized
manifest view, a compact link and a `linkRecommended` flag through Rust.
`createFileLink(address)` formats public links through the core grammar. Inputs
contain public addresses or canonical embedded DataMaps, optional relative paths,
size hints, `sha256` claims and torrent metadata. No TypeScript format encoder
or network upload is added. Exported embedded maps and links grant private-file
access.

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
- The ant-client golden v1 fixture with a creator's `sha256` decodes with it
  as hex; `createManifest` records a `sha256` through to the decoded bytes and
  link, and rejects a malformed one. `download()` returns an entry's bytes only
  when they match its `sha256`; `downloadAndSave()` writes nothing on a
  mismatch; a malformed `sha256` is refused before any fetch, and a missing
  WebCrypto fails the download.
- Client tests: an embedded entry routes to the private download and reader
  with the entry's file name and no public DataMap fetch; a public entry
  routes to the public download; an embedded entry without DataMap bytes is
  rejected.
- Acceptance requires human engineering review.
- [Main sync audit](../audits/2026-10-08-ant-client-main-sync.md): production
  WASM, SDK checks and real Chromium demo against the pinned browser devnet.
