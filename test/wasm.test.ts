import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { corePublicFile, publicFileFromCore } from "../src/internal/protocol.js";
import { encryptPublicFile, parseBrowserManifest } from "../src/wasm/ant_core.js";
import { initializeWasm } from "../src/index.js";
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
