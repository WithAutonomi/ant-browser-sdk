# Autonomi Browser SDK

Build browser applications that connect directly to Autonomi storage nodes over
certificate-pinned WebRTC. The SDK packages the shared Rust client as WebAssembly
and adds the browser plumbing an application should not have to rebuild: bootstrap,
authenticated node discovery, file staging, payments, downloads, saving, progress,
and random-access media.

> **Status:** experimental. The direct browser protocol and manifest are currently
> versioned with the `ant-client` `browser-wasm` implementation. Pin SDK versions
> while the protocol is being stabilized.

## Quick start

```bash
npm install @autonomi/browser-sdk ethers
```

```ts
import { AutonomiClient } from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";

const client = await AutonomiClient.connect(
  "https://network.example/api/browser-manifest.json",
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

`connect` initializes WASM, validates untrusted metadata in Rust, opens a pinned
WebRTC DataChannel, and authenticates the bootstrap node's ML-DSA identity. It
accepts any of these sources:

```ts
await AutonomiClient.connect("https://host/browser-manifest.json");
await AutonomiClient.connect("/ip4/203.0.113.10/udp/24000/webrtc-direct/...");
await AutonomiClient.connect({ multiaddr: "/ip4/203.0.113.10/udp/24000/...");
await AutonomiClient.connect(manifestObject);
await AutonomiClient.connect([firstEndpoint, fallbackEndpoint]);
```

A manifest provides optional file names and MIME types. A single direct endpoint
is enough for address-only downloads: authenticated peers propagate other WebRTC
Direct addresses during closest-node lookup.

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

The core package has no wallet dependency. Implement `PaymentProvider` for any
wallet stack, or install the optional Ethers v6 adapter:

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

Or supply another adapter:

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

## Download and save

```ts
const download = await client.download(address, { concurrency: 3 });
image.src = URL.createObjectURL(download.blob);

// Uses showSaveFilePicker where available, then falls back to an <a download>.
await client.downloadAndSave(address);
```

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
`createMediaSource`. A site can only have one controlling worker per scope.

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
- The manifest host and payment RPC must allow the browser origin through CORS.
- Browser uploads currently accept files up to 1 GB. Complete downloads must fit
  in available page memory.

The bootstrap manifest is discovery material, not an identity authority. Every
node HELLO and storage quote is cryptographically checked, but production endpoint
publication still needs signed bootstrap records, certificate-rotation recovery,
relayed WebRTC, and traffic quotas.

## Run the included example

Start the browser-enabled devnet from the sibling `ant-node` checkout, then:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5174`. The example is intentionally small; its complete
logic is in [`examples/vanilla/main.ts`](examples/vanilla/main.ts).

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
