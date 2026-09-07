import { afterEach, expect, it, vi } from "vitest";
import { getBrowserCapabilities } from "../src/capabilities.js";

afterEach(() => vi.unstubAllGlobals());

it("reports missing APIs outside the browser without initialization or prompts", () => {
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("navigator", undefined);
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("RTCPeerConnection", undefined);
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("isSecureContext", undefined);
  const report = getBrowserCapabilities();
  expect(report.operations.connect.available).toBe(false);
  expect(report.operations.connect.missing).toContain("webRtc");
  expect(report.operations.uploadBlob.missing).toEqual(expect.arrayContaining(["worker", "indexedDb"]));
  expect(report.operations.media.missing).toEqual(expect.arrayContaining(["secureContext", "serviceWorker"]));
  expect(report.operations.saveWithDownload.available).toBe(false);
});

it("distinguishes optional upload/media/save APIs from basic connections", () => {
  const rtc = vi.fn();
  const picker = vi.fn();
  const openDb = vi.fn();
  const register = vi.fn();
  const worker = vi.fn();
  vi.stubGlobal("window", { showSaveFilePicker: picker });
  vi.stubGlobal("RTCPeerConnection", rtc);
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("indexedDB", undefined);
  vi.stubGlobal("isSecureContext", false);
  const first = getBrowserCapabilities();
  expect(first.operations.connect.available).toBe(true);
  expect(first.operations.uploadBytes.available).toBe(true);
  expect(first.operations.uploadBlob.available).toBe(false);
  expect(first.operations.saveWithPicker.missing).toEqual(["secureContext"]);
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("indexedDB", { open: openDb });
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("isSecureContext", true);
  const current = getBrowserCapabilities();
  expect(current.operations.uploadBlob.available).toBe(true);
  expect(current.operations.media.available).toBe(true);
  expect(current.operations.saveWithPicker.available).toBe(true);
  expect(first.operations.uploadBlob.available).toBe(false);
  for (const action of [rtc, picker, openDb, register, worker]) expect(action).not.toHaveBeenCalled();
  expect(Object.isFrozen(current)).toBe(true);
  expect(Object.isFrozen(current.features)).toBe(true);
  expect(Object.isFrozen(current.operations)).toBe(true);
  expect(Object.isFrozen(current.operations.media)).toBe(true);
  expect(Object.isFrozen(current.operations.media.missing)).toBe(true);
});

it("reports APIs blocked by property access without failing unrelated checks", () => {
  vi.stubGlobal("navigator", { get serviceWorker() { throw new DOMException("blocked", "SecurityError"); } });
  vi.stubGlobal("indexedDB", { get open() { throw new DOMException("blocked", "SecurityError"); } });
  const report = getBrowserCapabilities();
  expect(report.features.serviceWorker).toBe(false);
  expect(report.features.indexedDb).toBe(false);
  expect(report.features.blob).toBe(true);
});
