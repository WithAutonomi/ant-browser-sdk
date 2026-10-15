import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeManifest,
  initializeWasm,
  isManifestEntry,
  manifestEntrySource,
  manifestFileName,
  parseManifestLink,
} from "../src/index.js";

// Built by `ant manifest create --embed-public <address>=file.bin` against
// mainnet, using the finalized v1 layout with packed chunk records.
const LINK =
  "ant://manifest/wUFOVAGCpG5hbWWtbWFpbm5ldC1iZW5jaKdlbnRyaWVzkYKkcGF0aKhmaWxlLmJpbqZzb3VyY2WBqEVtYmVkZGVkgahkYXRhX21hcIKmY2h1bmtzxMxpRDt_7LwtBIlaUVXYSWWmtvExwFnaw-EI8BT00k2OeAyP9c_3dHKMJq3CcHm5mbxhu3qKkzaki2XUpqYzTQduAAAPUxh69f4_acErQX6MpRtt6kljlk5TBCCJtVNtnn6MHn2EfAZmDWcSgMWVUpWdZ_Lz7QMaRr7QL8HgLseYAy6z6acAAA9Tf0s-g-0LQ0Zo3tvNmAI0dOlovPC1iUNrL7ucFRXivzMdbXM2wOG9D4kZPFilIaxdj2Haac8s4Uq4D7uZJrgdDgAAD1SlY2hpbGQB";
// Superseded draft encoding from ant-client 0011a82; main deliberately rejects it.
const LEGACY_LINK =
  "ant://manifest/wUFOVAGCpG5hbWWtbWFpbm5ldC1iZW5jaKdlbnRyaWVzkYOkcGF0aKhmaWxlLmJpbqRzaXplwKZzb3VyY2WBqEVtYmVkZGVkgahkYXRhX21hcIOndmVyc2lvbgGxY2h1bmtfaWRlbnRpZmllcnOThKVpbmRleACoZHN0X2hhc2jcACBpRDt_zOzMvC0EzIlaUVXM2EllzKbMtszxMczAWczazMPM4QjM8BTM9MzSTcyOeKhzcmNfaGFzaNwAIAzMj8z1zM_M93RyzIwmzK3MwnB5zLnMmcy8Ycy7esyKzJM2zKTMi2XM1MymzKYzTQduqHNyY19zaXplzQ9ThKVpbmRleAGoZHN0X2hhc2jcACAYesz1zP4_aczBK0F-zIzMpRttzOpJY8yWTlMEIMyJzLVTbcyefsyMHn3MhKhzcmNfaGFzaNwAIHwGZg1nEsyAzMXMlVLMlcydZ8zyzPPM7QMaRsy-zNAvzMHM4C7Mx8yYAy7Ms8zpzKeoc3JjX3NpemXND1OEpWluZGV4Aqhkc3RfaGFzaNwAIH9LPsyDzO0LQ0ZozN7M28zNzJgCNHTM6WjMvMzwzLXMiUNrL8y7zJwVFczizL8zqHNyY19oYXNo3AAgHW1zNszAzOHMvQ_MiRk8WMylIcysXcyPYczaaczPLMzhSsy4D8y7zJkmzLgdDqhzcmNfc2l6Zc0PVKVjaGlsZAE";
const ADDRESS = "134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889";
// A .ant file with a v1 and a v2 torrent info hash over one public entry.
const TORRENT_MANIFEST_B64 = "wUFOVAGDpG5hbWWjdG9yp3RvcnJlbnSCrGluZm9faGFzaF92McQUzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc2saW5mb19oYXNoX3YyxCDv7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v76dlbnRyaWVzkYOkcGF0aKFhpHNpemXApnNvdXJjZYGmUHVibGljgadhZGRyZXNzxCCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urqw";

// Golden v1 bytes pinned by ant-client's manifest format test (9a2b635).
const GOLDEN_V1_HEX = "c1414e540182a46e616d65a172a7656e74726965739281a6736f7572636581a8456d62656464656481a8646174615f6d617081a66368756e6b73c444222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333330000010283a470617468a161a473697a6505a6736f7572636581a65075626c696381a761646472657373c4201111111111111111111111111111111111111111111111111111111111111111";

async function wasm() {
  await initializeWasm(await readFile(new URL("../src/wasm/ant_core_bg.wasm", import.meta.url)));
}

describe("manifests", () => {
  it("parses a manifest link into frozen entries with embedded DataMap bytes", async () => {
    await wasm();
    const parsed = await parseManifestLink(LINK);
    expect(parsed.kind).toBe("manifest");
    if (parsed.kind !== "manifest") return;
    expect(parsed.manifest.name).toBe("mainnet-bench");
    expect(Object.isFrozen(parsed.manifest.entries)).toBe(true);
    const entry = parsed.manifest.entries[0]!;
    expect(entry).toMatchObject({ name: "file.bin", path: "file.bin", kind: "embedded", address: ADDRESS });
    expect(entry).not.toHaveProperty("size");
    expect(entry).not.toHaveProperty("knownSize");
    expect(entry.dataMap).toBeInstanceOf(Uint8Array);
    expect(entry.dataMap!.byteLength).toBe(320);
    expect(manifestEntrySource(entry)).toEqual({ dataMap: entry.dataMap, name: "file.bin" });
  });

  it("carries a torrent reference when the creator recorded one", async () => {
    await wasm();
    // `ant manifest create --name tor --public-file <addr>=a --torrent-hash cd…(v1) --torrent-hash ef…(v2)`
    const bytes = Uint8Array.from(Buffer.from(TORRENT_MANIFEST_B64, "base64url"));
    const manifest = await decodeManifest(bytes);
    expect(manifest.torrent).toEqual({ infoHashV1: "cd".repeat(20), infoHashV2: "ef".repeat(32) });
    expect(Object.isFrozen(manifest.torrent)).toBe(true);
    const plain = await parseManifestLink(LINK);
    expect(plain.kind === "manifest" && plain.manifest.torrent).toBeUndefined();
  });

  it("parses file links and bare addresses, and rejects decorated file links", async () => {
    await wasm();
    expect(await parseManifestLink(`ant://${ADDRESS}`)).toEqual({ kind: "file", address: ADDRESS });
    expect(await parseManifestLink(ADDRESS)).toEqual({ kind: "file", address: ADDRESS });
    await expect(parseManifestLink(`ant://${ADDRESS}?dn=x`)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(parseManifestLink("ant://manifest/!!!")).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("decodes manifest bytes and requires the full header", async () => {
    await wasm();
    const bytes = Uint8Array.from(Buffer.from(LINK.slice("ant://manifest/".length), "base64url"));
    const manifest = await decodeManifest(bytes);
    expect(manifest.entries[0]!.address).toBe(ADDRESS);
    await expect(decodeManifest(bytes.subarray(1))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(decodeManifest(new Uint8Array())).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("decodes the core's golden v1 fixture and derives the root map size", async () => {
    await wasm();
    const manifest = await decodeManifest(Uint8Array.from(Buffer.from(GOLDEN_V1_HEX, "hex")));
    expect(manifest.name).toBe("r");
    const embedded = manifest.entries.find((entry) => entry.kind === "embedded")!;
    expect(embedded.knownSize).toBe(258);
    expect(embedded).not.toHaveProperty("size");
    expect(embedded.name).toBe(embedded.address);
    expect(embedded.dataMap).toBeInstanceOf(Uint8Array);
    const publicEntry = manifest.entries.find((entry) => entry.kind === "public")!;
    expect(publicEntry).toMatchObject({ name: "a", path: "a", size: 5, address: "11".repeat(32) });
    expect(publicEntry).not.toHaveProperty("knownSize");
  });

  it("rejects the superseded draft DataMap layout and unsupported versions", async () => {
    await wasm();
    await expect(parseManifestLink(LEGACY_LINK)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const bytes = Uint8Array.from(Buffer.from(LINK.slice("ant://manifest/".length), "base64url"));
    bytes[4] = 2;
    await expect(decodeManifest(bytes)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("maps entries to what the client reads", () => {
    const embedded = { name: "docs/a.pdf", kind: "embedded" as const, address: "ab".repeat(32), dataMap: Uint8Array.of(1) };
    const publicEntry = { name: "b", kind: "public" as const, address: "cd".repeat(32) };
    expect(isManifestEntry(embedded)).toBe(true);
    expect(isManifestEntry(publicEntry)).toBe(true);
    expect(isManifestEntry({ dataMap: Uint8Array.of(1) })).toBe(false);
    expect(isManifestEntry("ab".repeat(32))).toBe(false);
    expect(manifestEntrySource(embedded)).toEqual({ dataMap: Uint8Array.of(1), name: "a.pdf" });
    expect(manifestEntrySource(publicEntry)).toBe("cd".repeat(32));
    expect(manifestFileName({ name: "x/y/z.mp4" })).toBe("z.mp4");
    const { dataMap: _withheld, ...withoutDataMap } = embedded;
    expect(() => manifestEntrySource(withoutDataMap)).toThrow(/carries no DataMap/);
  });
});
