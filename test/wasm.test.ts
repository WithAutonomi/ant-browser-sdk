import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { corePublicFile, publicFileFromCore } from "../src/internal/protocol.js";
import { encryptPublicFile, parseBrowserManifest } from "../src/wasm/ant_core.js";
import { initializeWasm, SDK_LIMITS } from "../src/index.js";
import { getBindings } from "../src/internal/runtime.js";

describe("packaged Rust/WASM boundary", () => {
  it("loads the checked-in module and validates WebRTC Direct multiaddresses", async () => {
    const bytes = await readFile(
      new URL("../src/wasm/ant_core_bg.wasm", import.meta.url),
    );
    await initializeWasm(bytes);
    const parse = getBindings().parseWebRtcDirectMultiaddr;
    const parsed = parse(endpoint("AA".repeat(32), 0xbb));

    expect(parsed.multiaddr).toContain("/webrtc-direct/");
    expect(() => parse("https://network.example/bootstrap.json")).toThrow();
  });
});

function endpoint(peerId: string, certificateByte: number): string {
  const multihash = Uint8Array.from([
    0x12,
    0x20,
    ...Array(32).fill(certificateByte),
  ]);
  const certificate = `u${Buffer.from(multihash).toString("base64url")}`;
  return `/ip4/127.0.0.1/udp/24000/webrtc-direct/certhash/${certificate}/p2p/${peerId}`;
}

it("round-trips camelCase file metadata through the packaged Rust manifest validator", async () => {
  await initializeWasm(await readFile(new URL("../src/wasm/ant_core_bg.wasm", import.meta.url)));
  const encrypted = encryptPublicFile(new Uint8Array(3_072));
  const descriptor = { name: "file.bin", size: 3_072, content_type: "application/octet-stream", replicas: 5,
    address: encrypted.address, blake3: encrypted.blake3, data_map_size: encrypted.data_map_size, chunks: encrypted.chunks };
  const sdkFile = publicFileFromCore(descriptor);
  const manifest = parseBrowserManifest({ version: 6, network_id: "api-contract-test",
    endpoints: [{ multiaddr: endpoint("ab".repeat(32), 0xbb) }],
    payment: { chain_id: 31337, payment_token_address: `0x${"11".repeat(20)}`, payment_vault_address: `0x${"22".repeat(20)}` },
    files: [corePublicFile(sdkFile)],
  });
  expect(manifest.files[0]).toEqual(descriptor);
  expect(sdkFile.chunks[0]).toHaveProperty("dstHash");
});

it("matches the bundled core's minimum encryption size and maximum descriptor size", async () => {
  await initializeWasm(await readFile(new URL("../src/wasm/ant_core_bg.wasm", import.meta.url)));
  expect(() => encryptPublicFile(new Uint8Array(SDK_LIMITS.minFileBytes - 1))).toThrow();
  const encrypted = encryptPublicFile(new Uint8Array(SDK_LIMITS.minFileBytes));
  expect(encrypted.chunks).toHaveLength(3);
  // Validate metadata at the maximum without allocating a gigabyte of file content.
  const descriptor = { name: "large.bin", size: SDK_LIMITS.maxFileBytes, content_type: "application/octet-stream", replicas: 5,
    address: encrypted.address, blake3: encrypted.blake3, data_map_size: encrypted.data_map_size,
    chunks: encrypted.chunks.map((chunk: { index: number }) => ({ ...chunk, src_size: chunk.index === 0 ? SDK_LIMITS.maxFileBytes - 2 : 1 })) };
  const manifest = { version: 6, network_id: "api-limits-test",
    endpoints: [{ multiaddr: endpoint("ab".repeat(32), 0xbb) }],
    payment: { chain_id: 31337, payment_token_address: `0x${"11".repeat(20)}`, payment_vault_address: `0x${"22".repeat(20)}` },
    files: [descriptor],
  };
  expect(parseBrowserManifest(manifest).files[0].size).toBe(SDK_LIMITS.maxFileBytes);
  descriptor.size++;
  expect(() => parseBrowserManifest(manifest)).toThrow();
});

it("ships provenance matching the bundled production WASM", async () => {
  const metadata = JSON.parse(await readFile(new URL("../src/wasm/source.json", import.meta.url), "utf8"));
  const bytes = await readFile(new URL("../src/wasm/ant_core_bg.wasm", import.meta.url));
  expect(metadata.wasmSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(metadata.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(metadata.features).toEqual(["browser-wasm"]);
  expect(metadata.defaultFeatures).toBe(false);
});

it("uses the packaged native validator for failed payment reconciliation", async () => {
  await initializeWasm(await readFile(new URL("../src/wasm/ant_core_bg.wasm", import.meta.url)));
  const client = new (getBindings().BrowserNetworkClient)([{ multiaddr: endpoint("ab".repeat(32), 0xbb) }]);
  const verify = vi.fn();
  const persist = vi.fn();
  // MessagePack { plans: {}, proofs: {} }: no pending payment to reconcile.
  const checkpoint = JSON.stringify({ scope: "empty-test-journal", state: "82a5706c616e7380a670726f6f667380" });
  try {
    await expect(client.reconcileFailedUploadPayment(checkpoint, verify, persist)).rejects.toBe("no pending payment");
    expect(verify).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  } finally {
    client.close();
    client.free();
  }
});
