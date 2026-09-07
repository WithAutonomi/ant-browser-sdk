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

Cancellation preserves the signal's original reason, so use
`client.pendingUploads` to find recoveries after an aborted upload; `recovery.id`
matches the initial upload's progress `operationId`. A submitted
payment can still confirm afterward: `recovery.settled` waits for the previous
attempt and its payment to settle, and `recovery.payments` then includes its
receipt. `resumeUpload()` waits for settlement too and rejects concurrent resumes.
A late successful upload is returned without uploading again.

Recovery handles survive `client.close()` and can be resumed by a new client in
the same page using the same payment RPC and contracts. They are not serialized
recovery files and do not survive a page reload. Release retained input when it
is no longer wanted, including before leaving the page:

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
  JsonRpcProvider,
  type Eip1193Provider,
} from "ethers";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

const injected = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
if (!injected) throw new Error("No injected EVM wallet is available");

const payment = createEthersPaymentProvider({
  getSigner: async (network) => {
    const walletProvider = new BrowserProvider(injected);
    const paymentProvider = new JsonRpcProvider(network.rpc_url);
    const [walletNetwork, paymentNetwork] = await Promise.all([
      walletProvider.getNetwork(),
      paymentProvider.getNetwork(),
    ]);

    if (walletNetwork.chainId !== paymentNetwork.chainId) {
      throw new Error(`Switch the wallet to chain ${paymentNetwork.chainId}`);
    }
    return walletProvider.getSigner();
  },
  approval: "exact",
});
```

`approval` can be `"exact"` or `"unlimited"`; it defaults to `"unlimited"` to
avoid another token-approval transaction on a later upload.

The `privateKey` option is convenient for a funded local-devnet wallet, but a
production private key must never be embedded in browser code:

```ts
const payment = createEthersPaymentProvider({
  privateKey: disposableDevnetPrivateKey,
  approval: "exact",
});
```

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
chain exposed by the authenticated node's payment RPC. The application remains
responsible for its wallet connection and chain-switching user experience.

### Custom payment provider

Implement `PaymentProvider` to integrate another wallet stack:

```ts
import type { PaymentProvider } from "@autonomi/browser-sdk";

const payment: PaymentProvider = {
  async pay(network, verifiedQuotes, { report }) {
    report("Confirm payment in your wallet");
    const receipt = await submitStoragePayment(network, verifiedQuotes);

    return {
      transactionHash: receipt.transactionHash,
      walletAddress: receipt.walletAddress,
      totalAmount: receipt.totalAmount.toString(),
    };
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
recovery. Throwing on cancellation after broadcast loses that recovery evidence.

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
needed. Each event has a stable `operationId`, `operation`, `phase`, and human
readable `message`. `completed`, `total`, and `unit` (`bytes`, `records`, or
`quotes`) are present where measured or known. Track concurrent operations by ID:

```ts
const unsubscribe = client.onProgress((event) => {
  updateOperation(event.operationId, {
    phase: event.phase,
    message: event.message,
    completed: event.completed,
    total: event.total,
    unit: event.unit,
  });
});
```

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

## Browser and deployment requirements

- A current browser with WebAssembly, `RTCPeerConnection`, Web Workers, Web
  Crypto, `Blob`, and `ReadableStream` support
- `FileReaderSync` and IndexedDB for staged `File` and `Blob` uploads
- Autonomi nodes exposing a WebRTC Direct listener and complete multiaddresses
  containing `/webrtc-direct/certhash/.../p2p/...`
- Enough IndexedDB quota to stage encrypted records for `File` and `Blob` uploads
- CORS access to the advertised payment RPC for Wagmi, private-key Ethers, and
  integrations that query that RPC directly
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
ANT_CLIENT_DIR=../ant-client npm run sync:wasm
npm run check
npm pack --dry-run
```

`ANT_CLIENT_DIR` defaults to the sibling `../ant-client` repository, so the
variable can be omitted for that layout. WASM protocol changes and matching SDK
types must ship in the same SDK release.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution requirements.

## Architecture boundaries

- Rust/WASM owns WebRTC, protocol framing, HELLO authentication, discovery,
  self-encryption, record verification, quote verification, payment planning,
  storage workflows, and range reads.
- This package owns initialization, TypeScript types, browser file staging,
  wallet adapters, save flows, media bridging, errors, and lifecycle management.
- Applications own UI, wallet and chain switching, policy, bootstrap distribution,
  and durable metadata for published files.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
