import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
