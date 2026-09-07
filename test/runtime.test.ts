import { afterEach, beforeEach, expect, it, vi } from "vitest";
const init = vi.hoisted(() => vi.fn());
vi.mock("../src/wasm/ant_core.js", () => ({
  default: init, BrowserNetworkClient: class {}, BrowserNodeClient: class {}, parseWebRtcDirectMultiaddr: vi.fn(),
}));
const bytes = () => Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
beforeEach(() => { vi.resetModules(); init.mockReset().mockResolvedValue({}); });
afterEach(() => vi.unstubAllGlobals());
it("shares the first compiled module across preinitialization and clients", async () => {
  const { initializeWasm, initializeClientWasm } = await import("../src/internal/runtime.js");
  await initializeWasm(bytes());
  const a = await initializeClientWasm();
  const b = await initializeClientWasm(bytes().buffer);
  expect(a).toBeInstanceOf(WebAssembly.Module);
  expect(b).toBe(a);
  expect(init).toHaveBeenCalledOnce();
  expect(init).toHaveBeenCalledWith({ module_or_path: a });
});
it("rejects conflicting sources even when initialization is concurrent", async () => {
  const { initializeClientWasm } = await import("../src/internal/runtime.js");
  const first = initializeClientWasm(bytes());
  const conflict = initializeClientWasm(Uint8Array.of(0, 97, 115, 109));
  await expect(conflict).rejects.toMatchObject({ code: "INITIALIZATION_FAILED", message: expect.stringContaining("different source") });
  expect(await initializeClientWasm()).toBe(await first);
  expect(init).toHaveBeenCalledOnce();
});
it("uses one default asset for both the page and workers", async () => {
  const fetch = vi.fn(async (_input: unknown) => new Response(bytes())); vi.stubGlobal("fetch", fetch);
  const { initializeClientWasm } = await import("../src/internal/runtime.js");
  const [a, b] = await Promise.all([initializeClientWasm(), initializeClientWasm()]);
  expect(a).toBe(b); expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0]?.[0])).toContain("wasm/ant_core_bg.wasm");
});
it("allows retry after initialization fails and snapshots caller-owned bytes", async () => {
  const { initializeClientWasm } = await import("../src/internal/runtime.js");
  await expect(initializeClientWasm(Uint8Array.of(0))).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
  const original = bytes();
  const module = await initializeClientWasm(original);
  original[0] = 42;
  expect(await initializeClientWasm(bytes())).toBe(module);
});
it("reuses a supplied compiled module and an already consumed response", async () => {
  const { initializeClientWasm } = await import("../src/internal/runtime.js");
  const response = new Response(bytes());
  const module = await initializeClientWasm(response);
  expect(await initializeClientWasm(response)).toBe(module);
  expect(await initializeClientWasm(module)).toBe(module);
});
