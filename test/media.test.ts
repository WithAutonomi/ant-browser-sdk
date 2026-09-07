import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicFileReader, type PublicFileReader } from "../src/file-reader.js";
import { MediaBridge } from "../src/internal/media.js";
import type { RawFileReader } from "../src/internal/runtime.js";

const origin = "https://app.example";
const defaultWorkerUrl = `${origin}/autonomi-stream-sw.js`;
const rootScopeUrl = `${origin}/`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaBridge service-worker registration", () => {
  it("rejects rather than replacing a different worker at the requested scope", async () => {
    const hostWorker = serviceWorker(`${origin}/service-worker.js`);
    const hostRegistration = registration(rootScopeUrl, hostWorker);
    const container = serviceWorkerContainer({
      registrations: [hostRegistration],
      ready: hostRegistration,
      controller: hostWorker,
    });
    stubBrowser(container);
    const bridge = new MediaBridge();

    await expect(bridge.attach(fileReader(), {})).rejects.toMatchObject({
      code: "MEDIA_FAILED",
      message: expect.stringContaining("A different service worker is already registered"),
    });
    expect(container.register).not.toHaveBeenCalled();

    const source = await bridge.attach(fileReader(), {
      serviceWorkerUrl: hostWorker.scriptURL,
    });
    expect(source.url).toContain(`${rootScopeUrl}__autonomi_stream/`);
  });

  it("reuses an existing integrated worker with the requested URL", async () => {
    const hostWorkerUrl = `${origin}/service-worker.js`;
    const hostWorker = serviceWorker(hostWorkerUrl);
    const hostRegistration = registration(rootScopeUrl, hostWorker);
    const container = serviceWorkerContainer({
      registrations: [hostRegistration],
      ready: hostRegistration,
      controller: hostWorker,
    });
    stubBrowser(container);

    const source = await new MediaBridge().attach(fileReader(), {
      serviceWorkerUrl: hostWorkerUrl,
    });

    expect(container.register).not.toHaveBeenCalled();
    expect(source.url).toContain(`${rootScopeUrl}__autonomi_stream/`);
  });

  it("registers the packaged worker when the requested scope is unused", async () => {
    const worker = serviceWorker(defaultWorkerUrl);
    const sdkRegistration = registration(rootScopeUrl, worker);
    const container = serviceWorkerContainer({
      registrations: [],
      ready: sdkRegistration,
      controller: worker,
      registered: sdkRegistration,
    });
    stubBrowser(container);

    await new MediaBridge().attach(fileReader(), {});

    expect(container.register).toHaveBeenCalledWith(defaultWorkerUrl, { scope: "/" });
  });
  it("routes each range only to its owning bridge when clients share a page", async () => {
    const worker = serviceWorker(defaultWorkerUrl);
    const sdkRegistration = registration(rootScopeUrl, worker);
    const container = serviceWorkerContainer({
      registrations: [sdkRegistration], ready: sdkRegistration, controller: worker,
    });
    const listeners = new Set<(event: unknown) => Promise<void>>();
    vi.mocked(container.addEventListener).mockImplementation((type, listener) => {
      if (type === "message") listeners.add(listener as unknown as (event: unknown) => Promise<void>);
    });
    vi.mocked(container.removeEventListener).mockImplementation((type, listener) => {
      if (type === "message") listeners.delete(listener as unknown as (event: unknown) => Promise<void>);
    });
    stubBrowser(container);
    const bridges = [new MediaBridge(), new MediaBridge()];
    const sources = await Promise.all(bridges.map((bridge) => bridge.attach(fileReader(), {})));
    for (const source of sources) {
      const postMessage = vi.fn();
      const sessionId = new URL(source.url).pathname.split("/")[2];
      await Promise.all([...listeners].map((listener) => listener({
        data: { type: "autonomi-file-range", sessionId, start: 0, length: 0 },
        ports: [{ postMessage }],
      })));
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage.mock.calls[0]![0]).toMatchObject({ ok: true });
    }
    bridges.forEach((bridge) => bridge.close());
    expect(listeners.size).toBe(0);
  });

});

function stubBrowser(container: ServiceWorkerContainer): void {
  vi.stubGlobal("location", {
    href: `${origin}/player`,
    origin,
  });
  vi.stubGlobal("navigator", { serviceWorker: container });
}

function serviceWorker(scriptURL: string): ServiceWorker {
  return { scriptURL } as ServiceWorker;
}

function registration(scope: string, active: ServiceWorker): ServiceWorkerRegistration {
  return {
    scope,
    installing: null,
    waiting: null,
    active,
  } as ServiceWorkerRegistration;
}

function serviceWorkerContainer(options: {
  registrations: ServiceWorkerRegistration[];
  ready: ServiceWorkerRegistration;
  controller: ServiceWorker;
  registered?: ServiceWorkerRegistration;
}): ServiceWorkerContainer {
  return {
    controller: options.controller,
    ready: Promise.resolve(options.ready),
    getRegistrations: vi.fn(async () => options.registrations),
    register: vi.fn(async () => options.registered ?? options.ready),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as ServiceWorkerContainer;
}

function fileReader(): PublicFileReader {
  const raw: RawFileReader = {
    name: "movie.mp4",
    size: 1_024,
    contentType: "video/mp4",
    readRange: vi.fn(async () => new Uint8Array()),
    close: vi.fn(),
    free: vi.fn(),
  };
  return createPublicFileReader(raw, "ab".repeat(32));
}
