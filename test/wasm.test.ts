import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { initializeWasm, parseManifest } from "../src/index.js";

const payment = {
  rpc_url: "http://127.0.0.1:8545",
  payment_token_address: `0x${"11".repeat(20)}`,
  payment_vault_address: `0x${"22".repeat(20)}`,
};

describe("packaged Rust/WASM boundary", () => {
  it("loads the checked-in module and validates manifests", async () => {
    const bytes = await readFile(
      new URL("../src/wasm/ant_core_bg.wasm", import.meta.url),
    );
    await initializeWasm(bytes);
    const manifest = await parseManifest({
      version: 5,
      network_id: "sdk-test",
      endpoints: [{ multiaddr: endpoint("AA".repeat(32), 0xbb) }],
      payment,
      files: [],
    });

    expect(manifest.endpoints[0]?.multiaddr).toContain("/webrtc-direct/");
    expect(manifest.payment.rpc_url).toBe("http://127.0.0.1:8545/");
    await expect(
      parseManifest({ ...manifest, endpoints: [] }),
    ).rejects.toMatchObject({ code: "MANIFEST_FAILED" });
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
