# ADR-0006: Private uploads keep the DataMap with its holder

- **Status:** Proposed
- **Date:** 2026-09-23
- **Decision owners:** Engineering team
- **Reviewers:** Pending human engineering review
- **Supersedes:** none
- **Superseded by:** none
- **Related:** ADR-0005; ant-client ADR-0004 amendment "Record batches and
  private DataMaps (2026-09-23)"; native `Visibility` and `datamap_file` in
  ant-core; `BrowserNetworkClient.downloadPrivateFile` and `openPrivateFile`

## Context

Native clients upload a file either publicly or privately. A public upload stores
the serialized DataMap as one more record, and its address identifies the file to
anyone. A private upload stores every other record, including nested DataMap
records, and returns the DataMap to the uploader. Native tools persist it as a
`.datamap` file whose content is the bare MessagePack DataMap, the same bytes as a
public DataMap record. Only a holder of those bytes can read the file.

The browser SDK only published files, and its reads only accepted a DataMap
address.

## Decision Drivers

- Offer the same visibility choice as native uploads.
- Interoperate with native `.datamap` files in both directions.
- Add no cryptography, record format, or wire change.
- Keep the secret DataMap out of the network, IndexedDB, and progress messages.
- Make it hard to mistake a private file for an addressable public one.

## Considered Options

1. **Public uploads only.** No parity with native private uploads.
2. **Return the canonical DataMap bytes in a `PrivateFile`.** Private files carry
   `dataMap: Uint8Array` and no address; reads accept them directly.
3. **Return the DataMap as a hex or base64 string.** Easier to put in JSON, but a
   second encoding of the native file format; applications can encode bytes.
4. **Keep private DataMaps in SDK-managed IndexedDB.** The SDK would own the
   lifetime and protection of application secrets, which belong to applications.

## Decision

We will adopt option 2.

- `UploadOptions.visibility` accepts `public` (the default, unchanged) or
  `private`. The browser default stays public for compatibility, although the
  native default is private.
- Private in-memory uploads self-encrypt as before and upload every record except
  the final DataMap record. The upload worker looks one record ahead and withholds
  the DataMap record instead of staging it; it completes the final window rather
  than opening another. The DataMap stays in page memory with the retained window
  until the upload completes or is discarded.
- `PrivateFile` has the public file's metadata except `address`, plus `dataMap`,
  the canonical MessagePack bytes. `UploadResult<F>` is generic over the file;
  `upload()` overloads return `UploadResult<PrivateFile>` for private uploads.
  `UploadRecovery.visibility` identifies retained uploads, and `resumeUpload()`
  returns `UploadResult<PublicFile | PrivateFile>`.
- `download()`, `downloadAndSave()`, `openFile()`, and `createMediaSource()` accept
  a `PrivateFile` or a `PrivateFileReference` holding just the DataMap and an
  optional name and content type, as a bare `.datamap` file provides. Only those
  fields reach the core, which resolves nested DataMap records from the network
  and bounds the DataMap by the maximum record size. `PrivateDownloadResult` has
  no `dataMapNode`, private readers report an empty `address`, and private files
  never enter `client.files`.

## Consequences

### Positive

- Browser and native private uploads are interchangeable through `.datamap` bytes.
- A private upload stores and pays for one record fewer than a public one.
- Private reads reuse the verified public read engine unchanged.

### Negative / Trade-offs

- `resumeUpload()` now returns a union file type; callers that read
  `result.file.address` must narrow first. Recoveries reach applications through
  errors and events, so a narrower static type is not available.
- The DataMap is a bearer secret: anyone holding it can read the file, and losing
  it loses access. Applications own its storage and protection.
- `PublicFileReader.address` is empty for private readers.

### Neutral / Operational

- No wire, record, or DataMap format changes; public uploads are unchanged.
- A private upload's checkpoint scope excludes the DataMap record, so public and
  private checkpoints for the same bytes are not interchangeable.

## Validation

- SDK tests for private in-memory and windowed uploads (no DataMap record staged
  or uploaded, returned bytes, visibility on recoveries), private download, save,
  and open, and published type overloads.
- ant-core WASM tests: a private upload leaves its DataMap unstored and downloads
  from it; a nested private DataMap supports range reads; oversized or corrupt
  DataMaps fail before any record is fetched.
- Review triggers: a change to the native `.datamap` format (for example the
  reserved envelope byte) or to native visibility semantics.

## Notes for AI-assisted work

AI tools may help draft this ADR, but **must not mark it Accepted without human review**. Accepted ADRs are immutable: create a new superseding ADR rather than editing an Accepted ADR.
