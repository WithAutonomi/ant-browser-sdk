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
// mainnet: one embedded entry whose DataMap is a shrunk child map.
const LINK =
  "ant://manifest/wUFOVAGCpG5hbWWtbWFpbm5ldC1iZW5jaKdlbnRyaWVzkYOkcGF0aKhmaWxlLmJpbqRzaXplwKZzb3VyY2WBqEVtYmVkZGVkgahkYXRhX21hcIOndmVyc2lvbgGxY2h1bmtfaWRlbnRpZmllcnOThKVpbmRleACoZHN0X2hhc2jcACBpRDt_zOzMvC0EzIlaUVXM2EllzKbMtszxMczAWczazMPM4QjM8BTM9MzSTcyOeKhzcmNfaGFzaNwAIAzMj8z1zM_M93RyzIwmzK3MwnB5zLnMmcy8Ycy7esyKzJM2zKTMi2XM1MymzKYzTQduqHNyY19zaXplzQ9ThKVpbmRleAGoZHN0X2hhc2jcACAYesz1zP4_aczBK0F-zIzMpRttzOpJY8yWTlMEIMyJzLVTbcyefsyMHn3MhKhzcmNfaGFzaNwAIHwGZg1nEsyAzMXMlVLMlcydZ8zyzPPM7QMaRsy-zNAvzMHM4C7Mx8yYAy7Ms8zpzKeoc3JjX3NpemXND1OEpWluZGV4Aqhkc3RfaGFzaNwAIH9LPsyDzO0LQ0ZozN7M28zNzJgCNHTM6WjMvMzwzLXMiUNrL8y7zJwVFczizL8zqHNyY19oYXNo3AAgHW1zNszAzOHMvQ_MiRk8WMylIcysXcyPYczaaczPLMzhSsy4D8y7zJkmzLgdDqhzcmNfc2l6Zc0PVKVjaGlsZAE";
const ADDRESS = "134e4537ad1b2e29f0dc48f8e025a560989e91055ebf1c66bca2208ca8bba889";

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
    expect(entry.dataMap).toBeInstanceOf(Uint8Array);
    expect(entry.dataMap!.byteLength).toBe(320);
    expect(manifestEntrySource(entry)).toEqual({ dataMap: entry.dataMap, name: "file.bin" });
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
