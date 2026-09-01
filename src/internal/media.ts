import { AutonomiError, errorMessage } from "../errors.js";
import type { PublicFileReader } from "../file-reader.js";
import type { MediaOptions, MediaSource } from "../types.js";

interface MediaSession {
  reader: PublicFileReader;
  source: MediaSource;
}

export class MediaBridge {
  #sessions = new Map<string, MediaSession>();
  #workerUrl?: string;
  #scope?: string;
  #messageListenerAttached = false;

  constructor() {}

  async attach(reader: PublicFileReader, options: MediaOptions): Promise<MediaSource> {
    const workerUrl = new URL(
      options.serviceWorkerUrl ?? "/autonomi-stream-sw.js",
      location.href,
    ).href;
    const scope = normalizeScope(options.scope ?? "/");
    await this.#ensureWorker(workerUrl, scope);
    if (!this.#messageListenerAttached) {
      navigator.serviceWorker.addEventListener("message", this.#onMessage);
      this.#messageListenerAttached = true;
    }

    const sessionId = randomSessionId();
    const url = new URL(`__autonomi_stream/${sessionId}/file`, new URL(scope, location.origin));
    url.searchParams.set("size", String(reader.size));
    url.searchParams.set("type", reader.contentType || "application/octet-stream");
    url.searchParams.set("name", reader.name);

    let closed = false;
    const source: MediaSource = {
      url: url.href,
      file: {
        address: reader.address,
        name: reader.name,
        size: reader.size,
        content_type: reader.contentType,
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#sessions.delete(sessionId);
        reader.close();
      },
    };
    this.#sessions.set(sessionId, { reader, source });
    return source;
  }

  close(): void {
    for (const { source } of this.#sessions.values()) source.close();
    this.#sessions.clear();
    if (this.#messageListenerAttached) {
      navigator.serviceWorker.removeEventListener("message", this.#onMessage);
      this.#messageListenerAttached = false;
    }
  }

  #onMessage = async (event: MessageEvent<unknown>): Promise<void> => {
    const data = event.data as {
      type?: string;
      sessionId?: string;
      start?: number;
      length?: number;
    };
    if (data?.type !== "autonomi-file-range") return;
    const port = event.ports[0];
    if (!port) return;
    try {
      const { start, length } = data;
      if (
        typeof data.sessionId !== "string" ||
        typeof start !== "number" ||
        typeof length !== "number" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(length) ||
        start < 0 ||
        length < 0
      ) {
        throw new Error("The service worker requested an invalid file range");
      }
      const session = this.#sessions.get(data.sessionId);
      if (!session) throw new Error("The requested media session is closed");
      const bytes = await session.reader.read(start, length);
      const owned =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes
          : bytes.slice();
      port.postMessage({ ok: true, bytes: owned.buffer }, [owned.buffer]);
    } catch (error) {
      port.postMessage({ ok: false, error: errorMessage(error) });
    }
  };

  async #ensureWorker(workerUrl: string, scope: string): Promise<void> {
    if (!("serviceWorker" in navigator)) {
      throw new AutonomiError(
        "MEDIA_FAILED",
        "Media streaming requires a secure context (HTTPS; localhost is allowed) with service-worker support",
      );
    }
    if (this.#workerUrl && (this.#workerUrl !== workerUrl || this.#scope !== scope)) {
      throw new AutonomiError(
        "MEDIA_FAILED",
        "One client cannot use multiple Autonomi media service-worker locations",
      );
    }
    this.#workerUrl = workerUrl;
    this.#scope = scope;
    const registration = await navigator.serviceWorker.register(workerUrl, { scope });
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller?.scriptURL === workerUrl) return;
    if (registration.active?.scriptURL === workerUrl) {
      await waitForController(workerUrl);
      return;
    }
    await waitForController(workerUrl);
  }
}

function normalizeScope(scope: string): string {
  const path = new URL(scope, location.origin).pathname;
  return path.endsWith("/") ? path : `${path}/`;
}

function randomSessionId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function waitForController(workerUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      reject(
        new AutonomiError(
          "MEDIA_FAILED",
          "The media service worker did not take control of this page; reload once and retry",
        ),
      );
    }, 10_000);
    const changed = (): void => {
      if (navigator.serviceWorker.controller?.scriptURL !== workerUrl) return;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    changed();
  });
}
