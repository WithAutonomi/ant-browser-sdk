# Autonomi Browser SDK

Build browser applications that connect directly to Autonomi storage nodes over
certificate-pinned WebRTC. The SDK combines the shared Rust client compiled to
WebAssembly with browser-native file handling, wallet adapters, progress events,
downloads, save flows, and random-access media streaming.

No gateway proxies file data: the browser authenticates nodes and communicates
with them directly.

> [!WARNING]
> This SDK and the direct-browser protocol are experimental. Pin the SDK version
> and test it against the exact `ant-node` version used by your deployment.

## Features

- Certificate-pinned WebRTC Direct connections and authenticated node discovery
- Public-file self-encryption, content addressing, paid upload, and verified download
- Incremental `File` and `Blob` processing in a worker with IndexedDB staging,
  in storage-bounded windows when a file does not fit the origin's quota
- Optional Ethers v6 and Wagmi/Viem payment adapters
- A wallet-independent `PaymentProvider` interface
- Explicit quote review before wallet payment
- Bounded random-access reads and seekable `<video>` or `<audio>` sources
- Stable SDK error codes and operation-level progress events

## Installation

Install the core package:

```bash
npm install @withautonomi/browser-sdk
```

Install only the wallet integration your application uses:

```bash
# Ethers v6
npm install ethers

# Wagmi v3 with Viem
npm install @wagmi/core viem
```

The package is ESM-only. Installing or building it with npm requires Node.js
20.19 or newer.

## Network defaults

The SDK reads mainnet configuration from the bundled Rust core:

```ts
import { AutonomiClient, getNetworkDefaults } from "@withautonomi/browser-sdk";

const defaults = await getNetworkDefaults();
// defaults: { id, seeds, payment, rpcUrl }
// `seeds` contains only WebRTC Direct multiaddresses, never native QUIC addresses.
const client = await AutonomiClient.connect();
// Equivalent: AutonomiClient.connect({ network: "mainnet", payment, onProgress });
```

**Mainnet WebRTC seeds have not been published yet.** `getNetworkDefaults()`
currently returns an empty seed list along with the mainnet payment identity and
public RPC URL. `connect()` rejects with `CONNECTION_FAILED` and a message naming
that missing configuration. It does not try QUIC endpoints or contact the RPC.
Use an explicit devnet address or trusted custom profile until seeds are added.

To use an application-owned network, pass a profile:

```ts
const client = await AutonomiClient.connect({
  network: {
    id: "my-devnet",
    seeds: trustedWebRtcMultiaddrs,
    payment: expectedPaymentNetwork,
  },
  payment,
});
```

Profiles require at least one distinct, complete WebRTC Direct multiaddress.
`connectNetwork(profile, options)` also remains available. The SDK validates all
seeds before dialing, tries them in order, and checks the authenticated payment
identity against the profile. A custom profile never falls back to mainnet.
Existing `connect(multiaddr, options)` behavior is unchanged.

`getNetworkDefaults({ wasm, signal })` supports a custom WASM source and
cancellation. Its frozen result can also supply `rpcUrl` when configuring Ethers
or a Wagmi public-client transport for mainnet; wallet providers and explicit
application RPC settings remain authoritative. Payment adapters still verify
provider chains. Obtaining defaults loads WASM as needed and issues no EVM RPC.

### Adding mainnet seeds (SDK maintainers)

The shared client owns `ant-core/resources/bootstrap_peers.toml`, with `quic` and
`webrtc` arrays of multiaddresses. Native release packaging ships the same file;
WASM exposes only `webrtc`. To activate browser defaults:

1. Add verified full `/ip4|ip6/.../udp/.../webrtc-direct/certhash/.../p2p/...`
   addresses to `webrtc`. Keep `quic` addresses in their own array.
2. Commit the shared source and run
   `ANT_CLIENT_DIR=/path/to/ant-client-web-support npm run sync:wasm` from a clean
   checkout. Commit all generated WASM files and provenance together.
3. Run the SDK checks, example builds, package checks, and a compatible browser
   devnet test. Validate the real mainnet seeds before publishing the SDK.

No TypeScript endpoint constants or connection changes are needed when the seed
list is populated. Publish updated artifacts when seeds change and retain an
operational overlap for old certificate pins.

## Quick start

Connect with one complete WebRTC Direct multiaddress, then download a public file
by its DataMap address:

```ts
import { AutonomiClient } from "@withautonomi/browser-sdk";

const bootstrapMultiaddr =
  "/ip4/203.0.113.10/udp/24000/webrtc-direct/certhash/.../p2p/...";
const publicFileAddress = "0123456789abcdef...";

const client = await AutonomiClient.connect(bootstrapMultiaddr, {
  onProgress: ({ operation, message }) => {
    console.log(`[${operation}] ${message}`);
  },
});

try {
  const result = await client.download(publicFileAddress);
  const url = URL.createObjectURL(result.blob);

  console.log(result.file.name, result.hash, url);
  // Assign `url` to an image, link, or other browser element as needed.
  // Call URL.revokeObjectURL(url) when the element no longer uses it.
} finally {
  client.close();
}
```

`AutonomiClient.connect()` initializes the bundled WASM module, validates the
multiaddress in Rust, opens a certificate-pinned WebRTC DataChannel, and
authenticates the bootstrap node's ML-DSA identity. A single direct endpoint is
enough: authenticated peers can advertise additional WebRTC Direct addresses
during closest-node lookup.

Connection setup reads the payment chain ID and token/vault addresses from the
authenticated HELLO. `client.connection.paymentNetwork` and
`client.connection.bootstrap.payment` expose `chainId` as a non-negative safe
integer. Nodes never advertise an RPC URL. Connecting and reading files require
no EVM RPC access; payment adapters use the application's or wallet's provider
and verify its chain before approval or payment.

Applications can pin their own payment identity when connecting:

```ts
const client = await AutonomiClient.connect(bootstrapMultiaddr, {
  expectedPaymentNetwork: {
    chainId: applicationChainId,
    paymentTokenAddress: applicationTokenAddress,
    paymentVaultAddress: applicationVaultAddress,
  },
});
```

All three fields must match the authenticated HELLO; contract comparison ignores
case. A mismatch rejects with `NETWORK_MISMATCH` before creating the network
client or invoking a payment provider. The policy is copied when `connect()` is
called. Omitting it accepts the authenticated node's advertised payment identity.
Authentication establishes who advertised the identity; this optional policy
establishes which identity the application expects. Neither path needs an EVM RPC.

This SDK uses browser protocol v5 and browser manifest v6. Upgrade the node,
Rust/WASM client, and SDK together; older protocol versions are rejected. The bootstrap node must advertise the
`chunk_protocol` capability used by the shared ant-core Client.

Pass `wasm` when the bundled WASM asset must be served from a custom location.
The SDK compiles one module per page and shares that exact module with every
`File`/`Blob` upload worker. Later connections without `wasm` reuse it. An explicit
later source must contain the same bytes (or be the same compiled module);
conflicts reject with `INITIALIZATION_FAILED`. Reload the page to change modules.
Calling the exported `initializeWasm(source)` ahead of `connect()` uses this same
shared initialization, including for workers. Cancelling one connection stops
that caller waiting without cancelling initialization needed by other clients.

## Upload files

Uploads require a payment provider. Configure one when connecting or override it
for an individual upload:

```ts
const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });

const result = await client.upload(file, {
  onProgress: ({ message }) => updateStatus(message),
});

console.log(result.file.address);
console.log(result.storageCostAtto);
console.log(result.transactionHash);
```

`File` and `Blob` inputs are incrementally self-encrypted in a dedicated worker.
Encrypted records are staged in IndexedDB instead of being accumulated in page
memory. A file whose encrypted records fit the origin's storage quota is staged
and uploaded as one batch. A larger file is uploaded in windows: the worker stages
as many records as the quota estimate allows, the native coordinator quotes, pays
for, and stores that window, and the SDK deletes it before the worker continues.
Each record is encrypted once, and IndexedDB never holds more than one window. A
window ends early if IndexedDB runs out of space before the estimate, and must hold
at least one encrypted record of up to 4 MiB.

Each window is a separate payment batch. `paymentMode: "auto"` applies the native
Merkle threshold to each window, and every window that needs payment requires its
own wallet transaction. Progress reports the window's record positions within the
whole file, and `staging` progress counts records encrypted so far.

After failure or cancellation, the `File` or `Blob` is retained for explicit
resume or discard, together with the window being uploaded; completed windows are
already released. Resuming uploads that staged window again, then re-encrypts the
file in the worker to continue after it. A partially staged window is cleared
when staging fails.

Use a `Uint8Array` for an in-memory upload. A name is optional and defaults to
`public-file.bin`. The SDK copies the byte array so later application edits cannot
change a resumed upload:

```ts
await client.upload(bytes, {
  name: "notes.txt",
  contentType: "text/plain",
});
```

The Rust core owns content addressing, closest-node selection, storage-quote and
commitment verification, payment-total calculation, quorum storage, fallback,
and retries. A payment provider receives verified quotes or a prepared Merkle transaction.

Upload preparation follows native ant-core's witnessed discovery flow: request
twenty initial responders, then fall back to seven if the wide lookup fails.
Both attempts use normal lookup behavior; WASM adds no special recovery probe,
cache bypass, or relaxed threshold. Like native's dial cache, browser endpoint
suppression applies to failed connections, not failed or grace-cancelled
FIND_NODE requests. Discovery failures therefore do not put otherwise reachable
endpoints into the connection-failure cache. Payment is requested only after its batch passes preparation. A recovery handle means input was retained, not that payment
was made: inspect both `payments` and `pendingPayments` before presenting retry
actions.

Uploads are public by default. Persist the returned DataMap address in application
storage if it must survive a page reload; `client.files` is only an in-memory list
of public files for the current client instance.

Uploads use the shared native coordinator. `paymentMode` defaults to `"auto"`,
which selects Merkle payment at the native record-count threshold and falls back
to single-node waves if candidate pools cannot be filled before payment. Set
`paymentMode: "single"` or `paymentMode: "merkle"` to force a mode. Ethers and
wagmi providers support both; custom providers implement optional `payMerkle`
to submit Rust-generated calldata and decode the confirmed receipt through
`context.decodeReceipt(receipt.logs)`. Forced Merkle never falls back silently.
Results report the mode actually used as `paymentMode`, like native
`payment_mode_used`: `"merkle"` once any record was paid through a Merkle batch,
otherwise `"single"`.

### Private uploads

Pass `visibility: "private"` to keep the file's DataMap off the network, as native
private uploads do. The result's `file` is a `PrivateFile` whose `dataMap` holds the
canonical MessagePack DataMap, byte-for-byte the content of a native `.datamap`
file. Holding it is what grants read access, so store it as carefully as the file
itself. Every other record, including nested DataMap records, is stored and paid
for as usual; a private upload stores and pays for one record fewer than a public one.

```ts
const { file } = await client.upload(input, { visibility: "private" });
await dataMapStore.save(`${file.name}.datamap`, file.dataMap);

// Later, or with a `.datamap` file written by the native CLI:
const dataMap = new Uint8Array(await datamapFile.arrayBuffer());
const { bytes } = await client.download({ dataMap, name: "holiday.jpg" });
```

`download()`, `downloadAndSave()`, `openFile()`, and `createMediaSource()` accept a
`PrivateFile` or any `PrivateFileReference`: the `dataMap` bytes plus an optional
`name` and `contentType`. Only those fields reach the core; size and chunks come
from the resolved DataMap, and an unnamed file gets a name derived from it. Private
download results have no `dataMapNode`, private readers have an empty `address`,
and private files never appear in `client.files`. Native tools write `.datamap`
files as the same MessagePack bytes. Upload recoveries report their
`visibility`, and `resumeUpload()` returns a `PublicFile` or `PrivateFile` to match.

### Resume a failed upload

`UploadError` extends `AutonomiError`, preserves its error code, and exposes a
`recovery` handle once the SDK has prepared input. Inspect confirmed payments and
retry the retained input with `resumeUpload()`:

```ts
import { UploadError } from "@withautonomi/browser-sdk";

try {
  await client.upload(file);
} catch (error) {
  if (!(error instanceof UploadError)) throw error;
  const recovery = error.recovery;

  await recovery.settled;
  console.log(recovery.payments); // network, verified quotes, and each receipt
  const uploaded = await client.resumeUpload(recovery);
  console.log(uploaded.file.address);
}
```

A resume without `payment` never authorizes another wallet transaction. It reuses
a retained receipt only when one confirmed transaction covers every currently
requested quote, including its amount and recipient. The Rust core obtains and
verifies quotes again and skips records already stored. Changed or expired quotes,
or a plan requiring multiple previous transactions, can produce
`RECOVERY_PAYMENT_REQUIRED`. The recovery remains available. Explicitly pass a
provider to authorize payment for an uncovered plan; a manual provider lets the
user review that plan before paying:

```ts
await client.resumeUpload(recovery, {
  payment: createManualPaymentProvider({
    payment: walletPayment,
    onRequest: showQuoteReview,
  }),
});
```

The explicit provider pays the whole newly requested plan, which can overlap a
previous payment. The client's default provider is deliberately not used for
this additional authorization. Successful results include `payments` for every
confirmed payment across attempts, and `storageCostAtto` is their total.
`transactionHash` identifies the final storage transaction when one exists; use
`payments` for the complete history.

Cancellation preserves the signal's original reason. Failed and cancelled upload
progress events carry their retained `recovery` directly when input was prepared;
`recovery.id` matches the initial upload's `operationId`. `client.pendingUploads`
also lists retained uploads. A submitted
payment can still confirm afterward: `recovery.settled` waits for the previous
attempt and its payment to settle, and `recovery.payments` then includes its
receipt. `resumeUpload()` waits for settlement too and rejects concurrent resumes.
A late successful upload is returned without uploading again.

Recovery handles survive `client.close()` and can be resumed by a new client in
the same page using the same payment chain ID and contracts. They are not
serialized recovery files and do not survive a page reload. Release retained
input when it is no longer wanted, including before leaving the page:

```ts
await recovery.discard();
// Or dispose of every retained failure owned by this client:
await Promise.all(client.pendingUploads.map((pending) => pending.discard()));
```

Discard waits for pending work before clearing records and is idempotent. Receipt
history remains readable afterward. Pass `retainOnFailure: false` to `upload()`
for automatic cleanup after a failed attempt settles. If successful-upload
cleanup fails, its handle remains in `pendingUploads` so cleanup can be retried.

### Connection snapshots

`client.connection` and `client.files` return frozen snapshots, including nested
payment configuration and file metadata. A previously captured snapshot does
not change when another upload or download finishes. Read the getters again to
obtain current files. Use `setPaymentProvider()` to change the default wallet;
connect a new client to select another network.

## Wallets and payments

The core entry point has no wallet dependency. Use an optional adapter or
implement `PaymentProvider` for another wallet stack.

Both adapters accept successful wallet speed-ups and return the replacement
transaction hash. Cancelled transactions, changed replacement transactions, and
reverted receipts fail payment. Private-key Ethers payments are serialized and
reload the pending nonce between attempts, including after a failed submission.
Cancellation is checked before approval/payment submission and after progress
callbacks; once a storage transaction starts, its eventual receipt is retained.

### Ethers v6

The Ethers adapter accepts either a signer resolver or a private key. For an
injected wallet, return a signer connected to the payment chain advertised by the
authenticated node:

```ts
import {
  BrowserProvider,
  type Eip1193Provider,
} from "ethers";
import { createEthersPaymentProvider } from "@withautonomi/browser-sdk/ethers";

const injected = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
if (!injected) throw new Error("No injected EVM wallet is available");

const payment = createEthersPaymentProvider({
  getSigner: async (network) => {
    const walletProvider = new BrowserProvider(injected);
    const walletNetwork = await walletProvider.getNetwork();

    if (walletNetwork.chainId !== BigInt(network.chainId)) {
      throw new Error(`Switch the wallet to chain ${network.chainId}`);
    }
    return walletProvider.getSigner();
  },
  approval: "exact",
});
```

`approval` can be `"exact"` or `"unlimited"`; it defaults to `"unlimited"` to
avoid another token-approval transaction on a later upload.

Before approval or payment, the adapter verifies that the signer's provider is
on `network.chainId`. A resolver must return a signer connected to a provider;
the application owns wallet connection and chain switching.

The `privateKey` option is convenient for a funded local-devnet wallet, but a
production private key must never be embedded in browser code:

```ts
const payment = createEthersPaymentProvider({
  privateKey: disposableDevnetPrivateKey,
  rpcUrl: applicationRpcUrl,
  approval: "exact",
});
```

Private-key payments require an explicit application-owned `rpcUrl`. For a
local devnet, use the Anvil JSON-RPC URL printed by `ant-devnet`. An injected
wallet's signer already has a provider and needs no `rpcUrl` option.

### Wagmi and Viem

Use the active connector from an existing Wagmi configuration:

```ts
import { createWagmiPaymentProvider } from "@withautonomi/browser-sdk/wagmi";
import { config } from "./wagmi-config";

const payment = createWagmiPaymentProvider({
  config,
  approval: "exact",
});

const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });
```

The Wagmi adapter uses the active connector directly and does not bridge through
Ethers. Before approval or payment, it checks that the connected wallet is on the
advertised `network.chainId`, and checks the public client's actual chain too.
Configure the payment chain and its RPC transport in the application's Wagmi
`config`. The application remains responsible for its wallet connection and
chain-switching user experience.

### Custom payment provider

Implement `PaymentProvider` to integrate another wallet stack:

Custom providers must verify that the wallet submits on `network.chainId`.
This single-node example uses `paymentMode: "single"` when uploading.

```ts
import { createPaymentSubmission, type PaymentProvider } from "@withautonomi/browser-sdk";

const payment: PaymentProvider = {
  async pay(network, verifiedQuotes, context) {
    if (verifiedQuotes.length === 0) return { totalAmount: "0" };
    context.report("Confirm payment in your wallet");
    context.signal?.throwIfAborted();
    const transaction = await broadcastStoragePayment(network, verifiedQuotes);
    const submission = createPaymentSubmission({
      transactionHash: transaction.hash,
      totalAmount: verifiedQuotes.reduce((sum, quote) => sum + BigInt(quote.amount), 0n).toString(),
    }, async () => {
      // Retry only observation of this transaction; never broadcast here.
      const receipt = await observeStoragePayment(transaction);
      if (receipt.reverted) return { status: "failed", reason: "Storage payment reverted" };
      return { status: "confirmed", receipt: {
        transactionHash: receipt.transactionHash,
        totalAmount: submission.totalAmount,
      } };
    });
    context.submitted(submission);
    const settlement = await submission.wait();
    if (settlement.status === "failed") throw new Error(settlement.reason);
    return settlement.receipt;
  },
};
```

`PaymentReceipt` is either a `PaidPaymentReceipt` with a required
`transactionHash`, or a `NoPaymentReceipt` with `totalAmount: "0"` and no
transaction hash. Return the latter only for an empty quote list. A nonempty
plan still requires a transaction hash when its quotes total zero tokens.

`totalAmount` must be a base-10 integer string that exactly matches the sum
calculated by the Rust core. The upload stops if the provider reports a different
amount. Providers should observe `context.signal` during pre-submission work and
check it immediately before submitting. After submitting storage payment, keep
observing its receipt and resolve with that receipt even if the signal aborts;
the SDK stops the upload waiting promptly and records the later receipt for
recovery. Call `context.submitted()` immediately after broadcast, even if cancellation
occurred while the wallet was submitting. The observer must reject on an unknown
outcome (such as an RPC timeout) and return `failed` only for a definitive failure.
Successful repricing may return a different confirmed transaction hash.

`upload()` and `resumeUpload()` accept `onPaymentSubmitted`, which receives a
`PendingPayment` handle before confirmation. Its immutable `submission` records
the broadcast hash and amount; `reconcile()` retries observation without paying
again. Concurrent calls share one observation and definitive outcomes are cached.
The callback can arrive after cancellation if broadcast was already in flight.

An upload recovery exposes unresolved submissions in `pendingPayments`.
`resumeUpload()` reconciles them before requesting quotes or invoking a wallet,
including when a new provider is explicitly supplied. An observation failure
produces `PAYMENT_UNRESOLVED`; confirmed payments join `recovery.payments` once.
A failed journal must be explicitly reconciled before another payment is allowed. Handles are
page-owned. Discarding retained file bytes does not erase transaction evidence
from handles already held by the application.

### Review quotes before payment

Wrap a wallet provider with `createManualPaymentProvider()` when the user must
review the verified storage price before paying:

```ts
import { createManualPaymentProvider } from "@withautonomi/browser-sdk";

const payment = createManualPaymentProvider({
  onRequest(request) {
    price.textContent = `${request.merkle ? "Up to " : ""}${request.totalAmountAtto} atto-tokens`;
    quoteCount.textContent = request.merkle ? "Merkle payment" : String(request.quotes.length);

    payButton.onclick = () => {
      void request.pay(getSelectedWalletPayment()).catch(showError);
    };
    cancelButton.onclick = () => {
      request.cancel("User declined the storage price");
    };
  },
});

// Self-encryption and quote verification begin immediately. The promise pauses
// at the payment boundary until pay() or cancel() is called.
const result = await client.upload(file, { payment });
```

`request.pay(provider)` accepts any `PaymentProvider` selected after quote
review and waits for its confirmed receipt. Alternatively, configure a default
provider in `createManualPaymentProvider()` and call `request.pay()` without an
argument. The wallet choice is locked once payment begins.

The same review callback handles native Merkle plans: `request.merkle` contains
the prepared plan, `quotes` is empty, and `totalAmountAtto` is the maximum charge.
The confirmed receipt reports the actual charge. The selected wallet must support
`payMerkle`; unsupported wallets leave the review pending so another can be chosen.
Journal recovery delegates to `recover`/`recoverMerkle` on the default provider
or the last provider selected for payment. Recovery does not open a review or
submit a transaction. After reload, configure the wallet provider again.

See the complete [manual-payment example](examples/manual-payment).

## Download and save

`download()` reconstructs the complete file and verifies its BLAKE3 hash before
returning both bytes and a `Blob`:

```ts
const result = await client.download(address);
image.src = URL.createObjectURL(result.blob);
```

Downloads default to `concurrency: "auto"`, using the shared native/WASM adaptive
scheduler. An integer from 1 through 256 sets a ceiling on logical record fetches.
The browser also bounds physical GET response reservations to 128 MiB. It reduces
admission when eight-response windows show sustained GET CPU load above half the
event loop and repeated processing or scheduling stalls above 50 ms. Isolated
slow responses and background timer clamping do not trigger that reduction. These
bounds include speculative GETs and can keep actual concurrency below your ceiling.
Complete downloads are memory-bound. Use a random-access reader for large media
or range-oriented formats.

For each record, the Rust client can try known or newly discovered candidates
while discovery continues, accepting only verified content. Early misses do not
establish absence. After discovery it tries the closest responders and up to 20 additional known
WebRTC Direct endpoints, including eligible cached routes and configured seeds.
A failed discovery request does not by itself disqualify a node from serving a
chunk. Fallback reads still authenticate nodes and verify the record's BLAKE3
hash. This also applies to DataMaps and media range reads; it cannot recover
records that are absent from all reachable holders.
Control and bulk RPCs use separate authenticated DataChannels on one WebRTC
connection. Nodes must allow two channels per connection (the current default).

These reads now use the same Rust Client as native `ant-core`. Corrupt content
fails immediately rather than being retried against another peer. Inconclusive
close-group sweeps retry after one second. Missing file records are retried as
a batch immediately once, then after 15 and 45 seconds. Nested DataMaps use the
native recursive resolver through an async batch adapter; full downloads and
media ranges share verified fetching and decryption with native callers.

Call `downloadAndSave()` directly from a user action. It opens
`showSaveFilePicker()` before starting the network request so the picker retains
the action's transient user activation, then downloads, verifies, and writes the
file. Browsers without the picker (or calls without activation) fall back to an
ordinary `<a download>` flow:

```ts
const { download, save } = await client.downloadAndSave(address, {
  suggestedName: "archive.bin",
});

console.log(download.hash, save.method);
```

Pass a previously selected `FileSystemFileHandle` as `fileHandle` to skip the
picker, or use `saveDownload()` directly when a `DownloadResult` has already been
fetched:

```ts
await client.downloadAndSave(address, { fileHandle });
await saveDownload(download, { fileHandle });
```

## Random-access reads

`openFile()` avoids reconstructing the entire file. Each `read()` call can request
at most 4 MiB, and `stream()` reads a half-open byte range with bounded chunks:

```ts
const reader = await client.openFile(address);

try {
  const header = await reader.read(0, 4096);
  const body = reader.stream({
    start: 4096,
    end: reader.size,
    chunkSize: 1024 * 1024,
  });

  // Consume `header` and `body`.
} finally {
  reader.close();
}
```

Create readers through `client.openFile()`. `PublicFileReader` remains exported
for type annotations and `instanceof` checks, with a private constructor and no
WASM reader types in its public declaration.

## Seekable media

Native `<video>` and `<audio>` seeking requires the packaged service worker.
Copy it to the application's public root so it is served as
`/autonomi-stream-sw.js`:

```bash
cp node_modules/@withautonomi/browser-sdk/dist/autonomi-stream-sw.js public/
```

Then create a media source:

```ts
const source = await client.createMediaSource(address);
video.src = source.url;

// Release the reader and range cache when playback is finished.
source.close();
```

The service worker translates HTTP byte-range requests into messages to the
page-owned authenticated reader; it does not connect to Autonomi nodes itself.
The page and client must therefore remain open while the media URL is in use.
Multiple clients can serve independent media sources on the same page.

If the application already has a root-scoped service worker, merge the
`autonomi-file-range` fetch and message-handling logic from the packaged worker
into it and pass that worker's URL:

```ts
const source = await client.createMediaSource(address, {
  serviceWorkerUrl: "/service-worker.js",
});
```

A site can have only one controlling service worker per scope. Media sources
refuse to replace a different worker already registered for their exact scope.
They also require a secure context (HTTPS or localhost), and the packaged bridge
accepts files up to 1,000,000,000 bytes (1 GB).

## Public metadata names

SDK metadata uses camelCase throughout, including `contentType`, `dataMapSize`,
`dstHash`, `srcHash`, `srcSize`, `peerId`, `nativeAddresses`, `webrtcDirect`,
`maxChunkSize`, `paymentTokenAddress`, and `paymentVaultAddress`. Readers and
media sources use the same `contentType` name as `PublicFile`.

Pass SDK `PublicFile` objects or address strings to downloads and readers.
Snake_case is confined to the private Rust/WASM wire representation; the SDK
converts at that boundary. `VerifiedStorageQuote.quote` remains an opaque proof
artifact and is not renamed. Applications persisting metadata from earlier SDK
versions must migrate the renamed fields before passing it to this API.

## Errors, progress, and cleanup

The bundled browser core distinguishes existing-storage checks from payment
quote preparation. Merkle preflight completion is not quote completion: candidate
payment pools are collected afterwards, with their own current-batch progress.
`Already present record` identifies chunks needing no new payment;
`Stored new record` identifies successful writes in this attempt. The aggregate
`Confirmed available record` includes both and must not be counted as new writes.
`Quoted record`, `Already present record`, and `Stored new record` carry stable
record indices, which may arrive out of order; their numerators are not counts.
Full-file downloads emit `Downloaded chunk completed/total` after verified
record fetches; final reconstruction and file verification still follow.
Core diagnostic messages remain text, separate from the SDK's structured phase
counters. Applications should not infer byte completion from lookup diagnostics.
Merkle payment review and confirmed/reused payment receipts have explicit SDK
payment/uploading phase events.

Network and client operation failures use `AutonomiError` with a stable `code`
and the original `cause`:

```ts
import { AutonomiError } from "@withautonomi/browser-sdk";

try {
  await client.download(address);
} catch (error) {
  if (error instanceof AutonomiError) {
    console.error(error.code, error.message, error.cause);
  }
}
```

Invalid factory arguments can throw `TypeError`. Canceling the native save-file
picker is intentionally rethrown as the browser's `AbortError`, allowing an
application to treat cancellation separately from a failed save.

Register a client-wide progress listener through `connect()` or
`client.onProgress()`, and pass `onProgress` to an individual operation when
needed. Each event has a stable `operationId`, `operation`, `status`, `phase`, and human
readable `message`. `completed`, `total`, and `unit` (`bytes`, `records`, or
`quotes`) are present where measured or known. Track concurrent operations by ID:

```ts
const unsubscribe = client.onProgress((event) => {
  updateOperation(event.operationId, {
    status: event.status,
    parentOperationId: event.parentOperationId,
    phase: event.phase,
    message: event.message,
    completed: event.completed,
    total: event.total,
    unit: event.unit,
  });
});
```

Each operation emits exactly one terminal `status`: `succeeded`, `failed`, or
`cancelled`. Earlier events have `status: "running"`; a `complete` phase alone is
not a terminal result. Failure/cancellation events carry the same `error` as the
rejected promise, plus `recovery` for an upload that retained input. This includes
cancellation caused by `client.close()` and failures during argument validation.
Terminal listener callbacks cannot alter a completed result.

`downloadAndSave()` emits its own events and child `download` and `save` events.
`createMediaSource()` similarly includes an `open-file` child. Children expose
`parentOperationId`, and the parent succeeds only after all its steps succeed.
Applications can also supply `parentOperationId` to group SDK calls under their
own task. Standalone `saveDownload()` accepts `onProgress` too; a successful anchor
save means the browser download was triggered, not that the user saved it to disk.

Phases identify SDK boundaries: initialization/connection, lookup, preparation,
staging, approval, payment, upload/download, opening, media, and completion.
Staging reports completed record counts; successful transfers report complete
byte counts. Opaque Rust diagnostic messages keep the current phase, and missing
counts mean progress is unknown. Counts are scoped to their phase and unit, not
a single percentage across the whole operation. A resumed attempt gets a new
operation ID. Events are frozen, and finished operations suppress late progress.
Listener exceptions are isolated; a listener may still cancel its operation
through its `AbortController`.

Long-running methods accept an `AbortSignal`, as do range reads, streams, and
save operations:

```ts
const controller = new AbortController();
const upload = client.upload(file, { signal: controller.signal });

controller.abort();
await upload; // rejects with AbortError
```

Aborting one operation does not close the client. Closing the client aborts all
active operations and terminates an active upload-staging worker. Cancellation
cannot reverse a wallet transaction that has already been submitted.

Call `close()` on clients, file readers, and media sources. Closing a client
closes its WebRTC associations and media sources; independently opened file
readers must still be closed by the application. Retained upload recoveries need
explicit resume or discard; closing the client does not discard them.

## Limits and capability discovery

Use `SDK_LIMITS` to configure file pickers, ranges, and concurrency controls:

```ts
import { SDK_LIMITS, getBrowserCapabilities } from "@withautonomi/browser-sdk";

const capabilities = getBrowserCapabilities();
uploadButton.disabled = !capabilities.operations.uploadBlob.available;
console.log(capabilities.operations.uploadBlob.missing);
console.log(SDK_LIMITS.maxFileBytes, SDK_LIMITS.maxRangeBytes);
```

| Limit | Value |
| --- | --- |
| `minFileBytes` / `maxFileBytes` | 3 / 1,000,000,000 bytes |
| `maxRangeBytes` | 4 MiB per read or stream chunk |
| `defaultStreamChunkBytes` | 1 MiB |
| `downloadConcurrency.min` / `.max` / `.default` | 1 / 256 / `"auto"` |
| `mediaMaxFileBytes` | 1,000,000,000 bytes |

The limits and capability reports are immutable. Unsupported input sizes are
rejected before copying byte arrays, staging Blobs, or opening files from supplied
metadata. Address-only reads learn the size from the core; media setup checks it
before registering a worker or creating a URL. These are protocol ceilings;
whole-file transfers still need sufficient memory, and staging needs quota for at
least one encrypted record.

`getBrowserCapabilities()` safely runs outside a browser and makes no network
requests, allocations of workers, or permission prompts. `features` reports each
API's presence. `operations` reports requirements for `connect`, `uploadBytes`,
`uploadBlob`, `download`, `read`, `stream`, `media`, `saveWithPicker`, and
`saveWithDownload`, including missing features for each. Call it again to get a
fresh snapshot.

`available` means required APIs are present. It does not probe permissions,
storage quota, CSP, media codecs, network access, or wallet availability. In
particular, `FileReaderSync` can only be checked inside the actual upload worker;
a positive Blob-upload report does not bypass that check. File-picker saving
still needs user activation. Read-only connections do not require a wallet,
IndexedDB, an upload worker, or payment RPC access.

## Browser and deployment requirements

- A current browser with WebAssembly, `RTCPeerConnection`, Web Workers, Web
  Crypto, `Blob`, and `ReadableStream` support
- `FileReaderSync` and IndexedDB for staged `File` and `Blob` uploads
- Autonomi nodes exposing a WebRTC Direct listener and complete multiaddresses
  containing `/webrtc-direct/certhash/.../p2p/...`
- For uploads, at least seven discoverable initial peers and enough eligible
  witnesses to support the paid quote; four successful stores complete delivery
- IndexedDB quota for at least one 4 MiB encrypted record per `File` or `Blob`
  upload window; a smaller quota means more windows and more payments
- CORS access to the application's payment RPC when the payment adapter queries
  it directly; injected wallets manage their own provider access
- A secure context and service-worker support for seekable media URLs
- Enough page memory for whole-file downloads and `Uint8Array` uploads

Ensure the bundler or deployment pipeline serves the package's WASM and worker
assets. For custom profiles, obtain bootstrap multiaddresses through a trusted deployment channel:
each address embeds a certificate pin and peer identity. Nodes and storage quotes
are authenticated, but endpoint publication, certificate rotation, availability,
and traffic policy remain deployment responsibilities.

## API overview

| API | Purpose |
| --- | --- |
| `SDK_LIMITS` | Inspect bundled file, range, concurrency, and media limits |
| `getBrowserCapabilities()` | Inspect browser API availability without prompting |
| `AutonomiClient.connect()` | Use mainnet defaults, a trusted profile, or an explicit WebRTC seed |
| `getNetworkDefaults()` | Read bundled mainnet WebRTC seeds, payment identity, and default RPC |
| `client.findClosest()` | Discover nodes closest to a 32-byte hex target |
| `client.upload()` | Self-encrypt, pay for, and publish a public file |
| `client.pendingUploads` | Inspect retained input and payment history after failures |
| `client.resumeUpload()` | Resume retained input with explicit authorization for new payments |
| `recovery.discard()` | Release retained input after pending work settles |
| `client.download()` | Fetch, reconstruct, and verify a complete public file |
| `client.downloadAndSave()` | Download and open a browser save flow |
| `client.openFile()` | Create a bounded random-access reader |
| `client.createMediaSource()` | Create a seekable media URL through a service worker |
| `client.setPaymentProvider()` | Replace the default provider for future uploads |
| `client.onProgress()` | Subscribe to progress and receive an unsubscribe function |
| `client.close()` | Release client-owned network and media resources |

Public types are exported from `@withautonomi/browser-sdk`. Adapter-specific
factories and option types are exported from `@withautonomi/browser-sdk/ethers` and
`@withautonomi/browser-sdk/wagmi`.

## Run the examples

Start a browser-enabled Autonomi devnet, then install dependencies and run the
all-in-one example:

```bash
npm ci
npm run dev
```

The examples use the following fixed local addresses:

| Example | Command | URL |
| --- | --- | --- |
| All-in-one | `npm run dev:all-in-one` | `http://127.0.0.1:5174` |
| Ethers connected wallet | `npm run dev:ethers` | `http://127.0.0.1:5175` |
| Wagmi connected wallet | `npm run dev:wagmi` | `http://127.0.0.1:5176` |
| Private key | `npm run dev:private-key` | `http://127.0.0.1:5177` |
| Review quotes, then pay | `npm run dev:manual-payment` | `http://127.0.0.1:5178` |

Each application is available under [`examples/`](examples). Build all five with
`npm run build:examples`.

## Maintainer workflow

The checked-in WASM artifact keeps npm installs independent of a Rust toolchain.
To rebuild it from an `ant-client` checkout:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
ANT_CLIENT_DIR=../ant-client-web-support npm run sync:wasm
npm run check
npm pack --dry-run
```

`ANT_CLIENT_DIR` defaults to the sibling `../ant-client-web-support` worktree, so the
variable can be omitted for that layout. WASM protocol changes and matching SDK
types must ship in the same SDK release. `src/wasm/source.json` records the
source commit, build features, lockfile hash, and binary hash; it ships in `dist/wasm`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution requirements.
Shared agent instructions are in [AGENTS.md](AGENTS.md); architecture decisions
and their review process are in [docs/adr/](docs/adr/).

## Architecture boundaries

The bundled WASM now uses the ordinary ant-core `data::Client`, importing
ant-protocol, saorsa-core, saorsa-pqc, and evmlib. Shared code owns quote
validation, U256 payment plans, native payment proofs, PUT retries/quorum, GET
integrity checks, caching, and in-memory reads. OS facilities are feature-gated.
The [earlier parity audit](docs/audits/2026-09-08-wasm-native-parity.md) describes
the previous artifact; its findings are not all current. Browser staged uploads,
JS wallet callbacks, session recovery, and cancellation still have adapter-specific
behavior and do not imply parity with native filesystem resume.

- Rust/WASM owns WebRTC, protocol framing, HELLO authentication, discovery,
  self-encryption, record verification, quote verification, payment planning,
  storage workflows, and range reads.
- Native and WASM share peer selection, discovery fallback, chunk verification,
  close-group and deferred file retries, DataMap resolution, and range reads in
  `ant-core/src/client_engine`. WebRTC, JS bindings, file descriptors, wallet
  callbacks, caches, and browser memory ceilings remain platform adapters.
- Shared upload policy includes native `ant-client` quote and commitment validation,
  witnessed quote eligibility, upper-median selection with a 3× payment,
  existing-holder voting, and storage-target ordering. The PUT neighbourhood
  widens to twenty peers when available, and fallback reuses the paid proof.
  Payment providers receive the selected verified quotes and amounts from Rust.
- This package owns initialization, TypeScript types, browser file staging,
  wallet adapters, save flows, media bridging, errors, and lifecycle management.
- Applications own UI, wallet and chain switching, policy, custom bootstrap distribution,
  and durable metadata for published files.

### Persisting upload recovery

The Rust client checkpoints its prepared payment plans before requesting a
wallet payment and its confirmed per-record proofs before uploading data. The
SDK persists these checkpoints in IndexedDB by default. To use your own durable
storage and recover after a reload, retain or reselect the same input:

```ts
let checkpoint = await checkpointStore.load(fileId);
await client.upload(file, {
  ...(checkpoint === undefined ? {} : { checkpoint }),
  payment,
  onCheckpoint: async (value) => {
    checkpoint = value;
    await checkpointStore.save(fileId, value);
  },
});
```

`checkpointStore` is application-owned storage, such as IndexedDB. The callback
is awaited before payment or record uploads proceed. A confirmed proof remains
usable with newly discovered peers and new quotes until the shared native expiry
policy says otherwise. Checkpoints are bound to the input records and payment
network, and contain no file bytes or private keys. When a `File` or `Blob` is
uploaded in several windows, each window has its own Rust checkpoint, which the SDK
wraps in an envelope naming the window's record range. Passing that checkpoint back
re-encrypts the file up to the window, stages exactly that window again, and
continues from there; windows before it are already stored. A plain checkpoint
covers the whole file, which must then be staged as one window. Windowed
checkpoints resume only `File` and `Blob` inputs. `reconcileFailedUploadPayment`
accepts either form and returns the same form. Submission evidence and raw
receipts are journaled before validation. Promise-based settlement observers stay
in the page; after reload the wallet's recovery methods observe the saved
transaction identity without submitting another payment.

### Payment journals and canonical file references

The SDK persists upload checkpoints in IndexedDB by default. Supplying
`onCheckpoint` selects application-owned persistence instead; that callback must
complete its durable write before returning. `storedUploadCheckpoints()` lists
journals retained across reloads. Reselect the same input and pass the saved
`checkpoint` to `upload()` to resume. IndexedDB is required for the default
journal even when the input is an in-memory byte array.

Wallet integrations report transaction submission immediately through
`context.submitted`. An ambiguous payment error never authorizes another
submission. The SDK observes retained submissions, and Ethers/Wagmi providers
can recover confirmed transactions from the journal by reading their calldata
and receipts. Custom providers can implement `recover` and `recoverMerkle`;
these methods must only observe existing transactions. An attempt with no usable
transaction identity stays unresolved until the wallet supplies that evidence.

For a definitively failed attempt, `client.reconcileFailedUploadPayment(checkpoint,
{ verifyFailure, onCheckpoint })` exposes the core's explicit reconciliation method.
Wait for the original upload and wallet work to finish first. The trusted
`verifyFailure(attempt, scope)` callback must independently verify the original
wallet and network, without submitting any transaction, and return either:

- `{ status: "notSubmitted", evidence: {...} }` only with proof the wallet never
  submitted and can no longer submit;
- `{ status: "reverted", transactionHashes: [...], evidence: {...} }` after
  verifying final reverts for **every** journaled transaction.

Timeouts and missing receipts do not establish failure. Rust validates the journal
coverage, archives failure evidence and retains earlier confirmed proofs.
`onCheckpoint` is required and awaited for durable persistence. Resume explicitly
using the returned checkpoint with `upload()` and the same input. Existing
in-memory recovery handles are not modified. The SDK never clears a journal just
because a payment callback rejected.

A public file is identified by its DataMap address. Read APIs pass only that
address and optional display metadata to Rust; size and chunk information come
from the verified map. Uploads return the `blake3` that native self-encryption
computed while reading all plaintext, including for `File` and `Blob` inputs.
Native Rust file APIs and stored record formats are unchanged.

Low-level WASM consumers now call `BrowserNodeClient.connect()` and use its
returned `BrowserNodeSession` for HELLO metadata and application requests. Close
that session when finished. Closed sessions reject requests; connecting again
creates a new authenticated session.

`AutonomiClient.connectNetwork(profile, options)` accepts a profile bundled with
the application, verifies its payment identity and tries its independent seeds.
A profile is a trust anchor and must not be populated from an untrusted runtime
manifest. Runtime manifests remain local-devnet tooling.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
