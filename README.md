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
- Incremental `File` and `Blob` processing in a worker with IndexedDB staging
- Optional Ethers v6 and Wagmi/Viem payment adapters
- A wallet-independent `PaymentProvider` interface
- Explicit quote review before wallet payment
- Bounded random-access reads and seekable `<video>` or `<audio>` sources
- Stable SDK error codes and operation-level progress events

## Installation

Install the core package:

```bash
npm install @autonomi/browser-sdk
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

## Quick start

Connect with one complete WebRTC Direct multiaddress, then download a public file
by its DataMap address:

```ts
import { AutonomiClient } from "@autonomi/browser-sdk";

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
memory, then cleared after a successful upload. After failure or cancellation,
prepared input is retained for explicit resume or discard; failed encryption
staging is still cleared immediately. The browser must have enough storage quota
for staged records, including retained failures.

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
and retries. A payment provider receives only verified quotes.

Upload preparation follows native ant-core's witnessed discovery flow: request
twenty initial responders, then fall back to seven if the wide lookup fails.
Both attempts use normal lookup behavior; WASM adds no special recovery probe,
cache bypass, or relaxed threshold. Like native's dial cache, browser endpoint
suppression applies to failed connections, not failed or grace-cancelled
FIND_NODE requests. Discovery failures therefore do not put otherwise reachable
endpoints into the connection-failure cache. Payment is requested only after all
records pass preparation. A recovery handle means input was retained, not that payment
was made: inspect both `payments` and `pendingPayments` before presenting retry
actions.

This SDK currently publishes public files. Persist the returned DataMap address
in application storage if it must survive a page reload; `client.files` is only
an in-memory list for the current client instance.

### Resume a failed upload

`UploadError` extends `AutonomiError`, preserves its error code, and exposes a
`recovery` handle once the SDK has prepared input. Inspect confirmed payments and
retry the retained input with `resumeUpload()`:

```ts
import { UploadError } from "@autonomi/browser-sdk";

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
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

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
import { createWagmiPaymentProvider } from "@autonomi/browser-sdk/wagmi";
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

```ts
import { createPaymentSubmission, type PaymentProvider } from "@autonomi/browser-sdk";

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
produces `PAYMENT_UNRESOLVED`; confirmed payments join `recovery.payments` once,
and a definitive failure permits a newly authorized payment. Handles are
page-owned. Discarding retained file bytes does not erase transaction evidence
from handles already held by the application.

### Review quotes before payment

Wrap a wallet provider with `createManualPaymentProvider()` when the user must
review the verified storage price before paying:

```ts
import { createManualPaymentProvider } from "@autonomi/browser-sdk";

const payment = createManualPaymentProvider({
  onRequest(request) {
    price.textContent = `${request.totalAmountAtto} atto-tokens`;
    quoteCount.textContent = String(request.quotes.length);

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

See the complete [manual-payment example](examples/manual-payment).

## Download and save

`download()` reconstructs the complete file and verifies its BLAKE3 hash before
returning both bytes and a `Blob`:

```ts
const result = await client.download(address, { concurrency: 3 });
image.src = URL.createObjectURL(result.blob);
```

Download concurrency must be an integer from 1 through 6 and defaults to 3.
Complete downloads are memory-bound. Use a random-access reader for large media
or range-oriented formats.

For each record, the Rust client first tries the closest discovery responders.
If those nodes cannot return it, the client tries up to 20 additional known
WebRTC Direct endpoints, including eligible cached routes and configured seeds.
A failed discovery request does not by itself disqualify a node from serving a
chunk. Fallback reads still authenticate nodes and verify the record's BLAKE3
hash. This also applies to DataMaps and media range reads; it cannot recover
records that are absent from all reachable holders.

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
cp node_modules/@autonomi/browser-sdk/dist/autonomi-stream-sw.js public/
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

Network and client operation failures use `AutonomiError` with a stable `code`
and the original `cause`:

```ts
import { AutonomiError } from "@autonomi/browser-sdk";

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
import { SDK_LIMITS, getBrowserCapabilities } from "@autonomi/browser-sdk";

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
| `downloadConcurrency.min` / `.max` / `.default` | 1 / 6 / 3 |
| `mediaMaxFileBytes` | 1,000,000,000 bytes |

The limits and capability reports are immutable. Unsupported input sizes are
rejected before copying byte arrays, staging Blobs, or opening files from supplied
metadata. Address-only reads learn the size from the core; media setup checks it
before registering a worker or creating a URL. These are protocol ceilings;
whole-file transfers still need sufficient memory and staging needs storage quota.

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
- Enough IndexedDB quota to stage encrypted records for `File` and `Blob` uploads
- CORS access to the application's payment RPC when the payment adapter queries
  it directly; injected wallets manage their own provider access
- A secure context and service-worker support for seekable media URLs
- Enough page memory for whole-file downloads and `Uint8Array` uploads

Ensure the bundler or deployment pipeline serves the package's WASM and worker
assets. Obtain bootstrap multiaddresses through a trusted deployment channel:
each address embeds a certificate pin and peer identity. Nodes and storage quotes
are authenticated, but endpoint publication, certificate rotation, availability,
and traffic policy remain deployment responsibilities.

## API overview

| API | Purpose |
| --- | --- |
| `SDK_LIMITS` | Inspect bundled file, range, concurrency, and media limits |
| `getBrowserCapabilities()` | Inspect browser API availability without prompting |
| `AutonomiClient.connect()` | Initialize WASM and authenticate a bootstrap node |
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

Public types are exported from `@autonomi/browser-sdk`. Adapter-specific
factories and option types are exported from `@autonomi/browser-sdk/ethers` and
`@autonomi/browser-sdk/wagmi`.

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
- Applications own UI, wallet and chain switching, policy, bootstrap distribution,
  and durable metadata for published files.

### Persisting upload recovery

The Rust client checkpoints its prepared payment plans before requesting a
wallet payment and its confirmed per-record proofs before uploading data. The
SDK retains these checkpoints for `resumeUpload()`. To recover after a reload,
persist the checkpoint and retain or reselect the same input:

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
network, and contain no file bytes or private keys. They do not contain the
wallet's unresolved transaction observers: persist submission evidence through
`onPaymentSubmitted` and reconcile it before authorizing a replacement payment.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
