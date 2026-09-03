# Autonomi Browser SDK

Build browser applications that connect directly to Autonomi storage nodes over
certificate-pinned WebRTC. The SDK packages the shared Rust client as WebAssembly
and adds the browser plumbing an application should not have to rebuild: bootstrap,
authenticated node discovery, file staging, payments, downloads, saving, progress,
and random-access media.

> **Status:** experimental. The direct browser protocol is currently versioned with
> the `ant-client` `browser-wasm` implementation. Pin SDK versions while the
> protocol is being stabilized.

## Quick start

```bash
npm install @autonomi/browser-sdk ethers
```

```ts
import { AutonomiClient } from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

const bootstrapMultiaddr =
  "/ip4/203.0.113.10/udp/24000/webrtc-direct/certhash/.../p2p/...";
const client = await AutonomiClient.connect(
  bootstrapMultiaddr,
  {
    payment: createEthersPaymentProvider({
      // Useful for a local devnet. In production, use getSigner instead.
      privateKey: devnetWalletKey,
    }),
    onProgress: ({ operation, message }) => {
      console.log(`[${operation}] ${message}`);
    },
  },
);

const uploaded = await client.upload(fileInput.files[0]);
console.log(uploaded.file.address);

const downloaded = await client.download(uploaded.file.address);
console.log(downloaded.file.name, downloaded.hash, downloaded.blob);

client.close();
```

`connect` initializes WASM, validates the multiaddress in Rust, opens a pinned
WebRTC DataChannel, and authenticates the bootstrap node's ML-DSA identity. Pass
one complete WebRTC Direct multiaddress:

```ts
await AutonomiClient.connect(
  "/ip4/203.0.113.10/udp/24000/webrtc-direct/certhash/.../p2p/...",
);
```

A single direct endpoint is enough: authenticated peers propagate other WebRTC
Direct addresses during closest-node lookup. Applications own durable metadata
about published files and can download using a public DataMap address alone.

## Upload a `File`

```ts
const result = await client.upload(file, {
  payment: myPaymentProvider, // optional when set during connect()
  onProgress: ({ message }) => updateStatus(message),
});
```

`File` and `Blob` inputs are incrementally self-encrypted in a dedicated worker.
Each encrypted record is staged in IndexedDB, uploaded, then removed—even after a
failed upload. This avoids holding both the original and encrypted file in page
memory. Pass a `Uint8Array` when an in-memory path is more convenient:

```ts
await client.upload(bytes, {
  name: "notes.txt",
  contentType: "text/plain",
});
```

The Rust core performs content addressing, closest-node selection, quote and
commitment verification, payment-total calculation, quorum storage, fallback,
and retry policy. A payment provider receives only verified quotes.

## Wallets and payments

The core package has no wallet dependency. Use one of the optional wallet
adapters, or implement `PaymentProvider` for another stack. With Ethers v6:

```ts
import { BrowserProvider } from "ethers";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

const payment = createEthersPaymentProvider({
  getSigner: async (_network) => {
    const provider = new BrowserProvider(window.ethereum);
    // Ensure the wallet is on the network advertised by the authenticated node.
    return provider.getSigner();
  },
  approval: "exact",
});
```

For a wallet already connected through Wagmi, install the Wagmi/Viem adapter:

```bash
npm install @autonomi/browser-sdk @wagmi/core viem
```

```ts
import { createWagmiPaymentProvider } from "@autonomi/browser-sdk/wagmi";
import { config } from "./wagmi-config";

const payment = createWagmiPaymentProvider({
  config,
  approval: "exact",
});

const client = await AutonomiClient.connect(bootstrapMultiaddr, { payment });
```

The adapter uses the active Wagmi connector directly; it does not convert the
wallet to Ethers. Before requesting approval or payment, it verifies that the
wallet is connected to the chain exposed by the authenticated node's payment
RPC. Applications remain responsible for presenting their preferred chain-switch
flow when those chains differ.

Or supply a custom adapter:

```ts
const payment = {
  async pay(network, verifiedQuotes, { report }) {
    report("Confirm payment in your wallet");
    const receipt = await wallet.payForStorage(network, verifiedQuotes);
    return {
      transactionHash: receipt.hash,
      totalAmount: receipt.totalAmount.toString(),
    };
  },
};
```

The returned `totalAmount` must be a decimal string exactly matching the sum the
Rust core calculated. A wallet callback cannot silently underpay or overpay and
continue the upload.

Complete, browser-runnable upload examples are included for a connected
[Ethers wallet](examples/ethers), a connected [Wagmi wallet](examples/wagmi),
and a [private-key wallet](examples/private-key). The private-key form is
intended only for disposable development wallets in browser applications.

### Present quotes before payment

Wrap any wallet provider with `createManualPaymentProvider` when an application
wants to show the verified storage price before asking the wallet to pay:

```ts
import { createManualPaymentProvider } from "@autonomi/browser-sdk";

const payment = createManualPaymentProvider({
  onRequest(request) {
    price.textContent = `${request.totalAmountAtto} atto-tokens`;
    quoteCount.textContent = String(request.quotes.length);

    payButton.onclick = () => {
      // Resolve this after quote review, so the user can switch wallet,
      // account, or Wagmi connector before clicking Pay.
      void request.pay(getSelectedWalletPayment()).catch(showError);
    };
    cancelButton.onclick = () => {
      request.cancel("User declined the storage price");
    };
  },
});

// Self-encryption and quote verification start now. This promise remains
// pending at the payment boundary until request.pay() is called.
const result = await client.upload(file, { payment });
```

`request.pay(provider)` accepts an Ethers, Wagmi, private-key, or custom provider
selected after quote review and waits for its confirmed receipt. Alternatively,
configure `payment` as a default in `createManualPaymentProvider` and call
`request.pay()` without an argument. Wagmi resolves its active connector, and
Ethers invokes `getSigner`, only when payment starts. The Rust upload then verifies
the reported total and only afterward starts storing records. See the complete
[button-driven and wallet-switchable example](examples/manual-payment).

## Download and save

Call `downloadAndSave()` directly from a user action so the native save picker
can use that action's transient activation.

```ts
const download = await client.download(address, { concurrency: 3 });
image.src = URL.createObjectURL(download.blob);

// Opens showSaveFilePicker before starting the network download.
await client.downloadAndSave(address);

// A previously selected FileSystemFileHandle skips the picker.
await client.downloadAndSave(address, { fileHandle });
```

Browsers without the picker, and picker `SecurityError` failures, fall back to an
ordinary `<a download>` flow.

Complete downloads are reconstructed and BLAKE3-verified before being returned.
They are memory-bound; use a random-access reader for large media or range-based
formats.

## Random access and media

Read at most 4 MiB at a time, or consume a bounded sequential `ReadableStream`:

```ts
const reader = await client.openFile(address);
const header = await reader.read(0, 4096);
const body = reader.stream({ chunkSize: 1024 * 1024 });
// ...consume body...
reader.close();
```

For native `<video>` and `<audio>` seeking, copy the included service worker to
your public root:

```bash
cp node_modules/@autonomi/browser-sdk/dist/autonomi-stream-sw.js public/
```

Then create a media source. The browser's ordinary HTTP byte ranges are bridged
to the page-owned authenticated reader; the service worker never contacts nodes.

```ts
const source = await client.createMediaSource(address);
video.src = source.url;

// Later:
source.close();
```

If the application already owns a root-scoped service worker, merge the small
`autonomi-file-range` handler from the packaged worker into it and pass its URL to
`createMediaSource`. A site can only have one controlling worker per scope. The
SDK refuses to replace a different worker already registered for the requested
scope.

## Error handling and cleanup

Every public failure is an `AutonomiError` with a stable `code` and original
`cause`:

```ts
import { AutonomiError } from "@autonomi/browser-sdk";

try {
  await client.download(address);
} catch (error) {
  if (error instanceof AutonomiError) console.error(error.code, error.cause);
}
```

Call `close()` on clients, file readers, and media sources. This closes WebRTC
associations and releases WASM and range-cache resources.

## Browser and deployment requirements

- A current browser with `RTCPeerConnection`, WebAssembly, Web Workers, and
  IndexedDB. Media URLs additionally need service workers and a secure context
  (localhost is accepted for development).
- Nodes must expose the Autonomi WebRTC Direct listener and complete multiaddresses
  containing `/webrtc-direct/certhash/.../p2p/...`.
- The payment RPC must allow the browser origin through CORS.
- Browser uploads currently accept files up to 1 GB. Complete downloads must fit
  in available page memory.

Obtain the bootstrap multiaddress through a trusted deployment channel: it embeds
the node's certificate pin and peer identity. Every node HELLO and storage quote
is cryptographically checked, but production endpoint publication still needs
certificate-rotation recovery, relayed WebRTC, and traffic quotas.

## Run the browser examples

Start the browser-enabled devnet from the sibling `ant-node` checkout, then:

```bash
npm install
npm run dev
```

`npm run dev` starts the [all-in-one example](examples/all-in-one) at
`http://127.0.0.1:5174`. Each payment integration is also a complete Vite app:

| Example | Command | URL |
| --- | --- | --- |
| All-in-one | `npm run dev:all-in-one` | `http://127.0.0.1:5174` |
| Ethers connected wallet | `npm run dev:ethers` | `http://127.0.0.1:5175` |
| Wagmi connected wallet | `npm run dev:wagmi` | `http://127.0.0.1:5176` |
| Private key | `npm run dev:private-key` | `http://127.0.0.1:5177` |
| Review quotes, then pay | `npm run dev:manual-payment` | `http://127.0.0.1:5178` |

Build all five examples with `npm run build:examples`.

## Maintainer workflow

The checked-in WASM artifact makes npm installs independent of Rust. To refresh it
from an `ant-client` checkout:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
ANT_CLIENT_DIR=../ant-client-web-support npm run sync:wasm
npm run check
npm pack --dry-run
```

`ANT_CLIENT_DIR` defaults to the sibling `../ant-client` repository. WASM protocol
changes and SDK types must ship in the same SDK release.

## What belongs where

- Rust/WASM owns WebRTC, framing, HELLO authentication, discovery, self-encryption,
  record verification, quotes, payment planning, upload/download, and range reads.
- This SDK owns initialization, ergonomic TypeScript types, browser file staging,
  wallet adapters, save flows, media bridging, errors, and lifecycle.
- Applications own UI, wallet/network UX, policy, and durable metadata about their
  published files.

Licensed under MIT or Apache-2.0, at your option.
