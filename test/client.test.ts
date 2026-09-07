import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualPaymentRequest } from "../src/manual-payment.js";
import type {
  PaymentProvider,
  PublicFile,
  SaveFileHandle,
} from "../src/types.js";

const state = vi.hoisted(() => ({
  hello: {
    type: "hello",
    protocol: "autonomi.web.poc.v4",
    peer_id: "ab".repeat(32),
    endpoint: { multiaddr: "/ip4/127.0.0.1/udp/24000/mock" },
    max_chunk_size: 4_194_304,
    capabilities: ["get_chunk", "put_chunk"],
    payment: {
      rpc_url: "http://127.0.0.1:8545/",
      payment_token_address: `0x${"11".repeat(20)}`,
      payment_vault_address: `0x${"22".repeat(20)}`,
    },
  },
  networks: [] as Array<{
    endpoints: unknown;
    closed: boolean;
    freed: boolean;
    findClosest: ReturnType<typeof vi.fn>;
    openPublicFile: ReturnType<typeof vi.fn>;
    uploadPublicFile: ReturnType<typeof vi.fn>;
    uploadStagedPublicFile: ReturnType<typeof vi.fn>;
    downloadPublicFile: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../src/internal/runtime.js", () => {
  class NodeClient {
    async hello(): Promise<unknown> {
      return state.hello;
    }
    close(): void {}
    free(): void {}
  }

  class NetworkClient {
    endpoints: unknown;
    closed = false;
    freed = false;
    findClosest = vi.fn(async () => ({ nodes: [], queried: [], failures: [] }));
    openPublicFile = vi.fn(async () => Promise.reject(new Error("not used")));
    uploadPublicFile = vi.fn();
    uploadStagedPublicFile = vi.fn(async () => Promise.reject(new Error("not used")));
    downloadPublicFile = vi.fn();

    constructor(endpoints: unknown) {
      this.endpoints = endpoints;
      state.networks.push(this);
    }

    close(): void {
      this.closed = true;
    }
    free(): void {
      this.freed = true;
    }
  }

  return {
    initializeClientWasm: vi.fn(async (source?: unknown) => source),
    getBindings: () => ({
      BrowserNodeClient: NodeClient,
      BrowserNetworkClient: NetworkClient,
      parseWebRtcDirectMultiaddr: (endpoint: unknown) => {
        if (typeof endpoint !== "string" || !endpoint.includes("/webrtc-direct/")) {
          throw new Error("invalid WebRTC Direct multiaddress");
        }
        return { multiaddr: endpoint };
      },
    }),
  };
});

import {
  AutonomiClient,
  AutonomiError,
  createManualPaymentProvider,
} from "../src/index.js";

const endpoint = "/ip4/127.0.0.1/udp/24000/webrtc-direct/mock";
const file: PublicFile = {
  name: "hello.txt",
  address: "33".repeat(32),
  size: 12,
  content_type: "text/plain",
  blake3: "44".repeat(32),
  data_map_size: 100,
  chunks: [],
  replicas: 5,
};

beforeEach(() => {
  state.networks.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AutonomiClient", () => {
  it("authenticates a direct endpoint and derives its payment network", async () => {
    const progress: string[] = [];
    const client = await AutonomiClient.connect(endpoint, {
      onProgress: ({ message }) => progress.push(message),
    });

    expect(client.connection.bootstrap.peer_id).toBe("ab".repeat(32));
    expect(client.connection.bootstrapMultiaddr).toBe(endpoint);
    expect(client.connection.paymentNetwork).toEqual(state.hello.payment);
    expect(state.networks[0]?.endpoints).toEqual([{ multiaddr: endpoint }]);
    expect(progress.at(-1)).toContain("Connected to authenticated peer");

    client.close();
    expect(state.networks[0]?.closed).toBe(true);
    expect(state.networks[0]?.freed).toBe(true);
    await expect(client.findClosest()).rejects.toBeInstanceOf(AutonomiError);
  });

  it("rejects bootstrap URLs instead of treating them as manifests", async () => {
    await expect(
      AutonomiClient.connect("https://network.example/browser-manifest.json"),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(state.networks).toHaveLength(0);
  });

  it("isolates connection progress listener failures", async () => {
    const onProgress = vi.fn(() => {
      throw new Error("broken status UI");
    });

    const client = await AutonomiClient.connect(endpoint, { onProgress });

    expect(onProgress).toHaveBeenCalled();
    expect(client.closed).toBe(false);
    expect(state.networks[0]?.closed).toBe(false);
    client.close();
  });

  it("cancels one lookup without closing the client", async () => {
    const client = await AutonomiClient.connect(endpoint);
    state.networks[0]!.findClosest.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();

    const lookup = client.findClosest(undefined, { signal: controller.signal });
    controller.abort();

    await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    expect(state.networks[0]?.closed).toBe(false);
    state.networks[0]!.findClosest.mockResolvedValue({
      nodes: [],
      queried: [],
      failures: [],
    });
    await expect(client.findClosest("11".repeat(32))).resolves.toMatchObject({
      nodes: [],
    });
    client.close();
  });

  it("aborts active operations when the client closes", async () => {
    const client = await AutonomiClient.connect(endpoint);
    state.networks[0]!.findClosest.mockReturnValue(new Promise(() => undefined));

    const lookup = client.findClosest();
    client.close();

    await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    expect(state.networks[0]?.closed).toBe(true);
    expect(state.networks[0]?.freed).toBe(true);
  });

  it("forwards custom WASM to staging and terminates its worker on close", async () => {
    const workers: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    }> = [];
    class PendingWorker {
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        workers.push(this);
      }
      addEventListener(): void {}
    }
    vi.stubGlobal("Worker", PendingWorker);
    const wasm = Uint8Array.of(0, 97, 115, 109).buffer;
    const payment: PaymentProvider = {
      pay: vi.fn(async () => ({ totalAmount: "0" })),
    };
    const client = await AutonomiClient.connect(endpoint, { payment, wasm });

    const upload = client.upload(new Blob([Uint8Array.of(1, 2, 3)]));
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const posted = workers[0]!.postMessage.mock.calls[0]![0] as {
      wasm: ArrayBuffer;
    };
    expect(new Uint8Array(posted.wasm)).toEqual(new Uint8Array(wasm));

    client.close();

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it("delegates an in-memory upload and exposes only verified quotes to payment", async () => {
    const payment: PaymentProvider = {
      pay: vi.fn(async (_network, quotes) => ({
        transactionHash: "0xpayment",
        totalAmount: quotes[0]?.amount ?? "0",
      })),
    };
    const client = await AutonomiClient.connect(endpoint, { payment });
    const network = state.networks[0];
    expect(network).toBeDefined();
    network!.uploadPublicFile.mockImplementation(
      async (
        _bytes: Uint8Array,
        _name: string,
        _type: string,
        paymentNetwork: unknown,
        payForQuotes: (network: unknown, quotes: unknown) => Promise<unknown>,
      ) => {
        await payForQuotes(paymentNetwork, [
          {
            quote: {},
            quoteHash: "55".repeat(32),
            rewardsAddress: `0x${"66".repeat(20)}`,
            amount: "42",
          },
        ]);
        return {
          file,
          transactionHash: "0xpayment",
          storageCostAtto: "42",
          records: 4,
        };
      },
    );

    const result = await client.upload(new Uint8Array(3_072), {
      name: "hello.txt",
      contentType: "text/plain",
    });

    expect(result.file).toEqual(file);
    expect(payment.pay).toHaveBeenCalledOnce();
    expect(client.files).toContainEqual(file);
    client.close();
  });

  it("pauses at verified quotes and continues after explicit payment", async () => {
    const walletPayment: PaymentProvider = {
      pay: vi.fn(async (_network, quotes) => ({
        transactionHash: "0xpayment",
        totalAmount: quotes[0]?.amount ?? "0",
      })),
    };
    let request!: ManualPaymentRequest;
    const payment = createManualPaymentProvider({
      payment: walletPayment,
      onRequest: (pending) => {
        request = pending;
      },
    });
    const client = await AutonomiClient.connect(endpoint, { payment });
    let continuedAfterPayment = false;
    state.networks[0]!.uploadPublicFile.mockImplementation(
      async (
        _bytes: Uint8Array,
        _name: string,
        _type: string,
        paymentNetwork: unknown,
        payForQuotes: (network: unknown, quotes: unknown) => Promise<unknown>,
      ) => {
        await payForQuotes(paymentNetwork, [
          {
            quote: {},
            quoteHash: "55".repeat(32),
            rewardsAddress: `0x${"66".repeat(20)}`,
            amount: "42",
          },
        ]);
        continuedAfterPayment = true;
        return {
          file,
          transactionHash: "0xpayment",
          storageCostAtto: "42",
          records: 4,
        };
      },
    );

    const upload = client.upload(new Uint8Array(3_072));
    await vi.waitFor(() => expect(request?.status).toBe("pending"));
    expect(continuedAfterPayment).toBe(false);
    expect(walletPayment.pay).not.toHaveBeenCalled();

    await request.pay();
    await expect(upload).resolves.toMatchObject({ storageCostAtto: "42" });
    expect(continuedAfterPayment).toBe(true);
    client.close();
  });

  it("returns verified bytes as both Uint8Array and Blob", async () => {
    const client = await AutonomiClient.connect(endpoint);
    const bytes = Uint8Array.of(1, 2, 3);
    state.networks[0]!.downloadPublicFile.mockResolvedValue({
      content: bytes,
      hash: file.blake3,
      file,
      dataMapNode: {
        peer_id: "77".repeat(32),
        native_addresses: [],
        reliability: 1,
      },
    });

    const result = await client.download(file.address);
    expect(result.bytes).toEqual(bytes);
    expect(result.blob.type).toBe("text/plain");
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
    client.close();
  });

  it("selects a save destination before starting the download", async () => {
    const events: string[] = [];
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const handle: SaveFileHandle = {
      name: "selected.txt",
      createWritable: vi.fn(async () => writable),
    };
    const showSaveFilePicker = vi.fn(async () => {
      events.push("picker");
      return handle;
    });
    vi.stubGlobal("window", { showSaveFilePicker });

    const client = await AutonomiClient.connect(endpoint);
    const bytes = Uint8Array.of(1, 2, 3);
    state.networks[0]!.downloadPublicFile.mockImplementation(async () => {
      events.push("download");
      return {
        content: bytes,
        hash: file.blake3,
        file,
        dataMapNode: {
          peer_id: "77".repeat(32),
          native_addresses: [],
          reliability: 1,
        },
      };
    });

    const result = await client.downloadAndSave(file);

    expect(events).toEqual(["picker", "download"]);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: file.name });
    expect(writable.write).toHaveBeenCalledWith(result.download.blob);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(result.save).toEqual({ method: "file-picker", name: "selected.txt" });
    client.close();
  });

  it("uses a previously selected file handle without opening the picker", async () => {
    const writable = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const fileHandle: SaveFileHandle = {
      createWritable: vi.fn(async () => writable),
    };
    const showSaveFilePicker = vi.fn();
    vi.stubGlobal("window", { showSaveFilePicker });

    const client = await AutonomiClient.connect(endpoint);
    state.networks[0]!.downloadPublicFile.mockResolvedValue({
      content: Uint8Array.of(1, 2, 3),
      hash: file.blake3,
      file,
      dataMapNode: {
        peer_id: "77".repeat(32),
        native_addresses: [],
        reliability: 1,
      },
    });

    const result = await client.downloadAndSave(file.address, { fileHandle });

    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(fileHandle.createWritable).toHaveBeenCalledOnce();
    expect(result.save).toEqual({ method: "file-picker", name: file.name });
    client.close();
  });

  it("falls back to an ordinary download when the picker lacks activation", async () => {
    const events: string[] = [];
    const securityError = new Error("User activation is required");
    securityError.name = "SecurityError";
    const showSaveFilePicker = vi.fn(async () => {
      events.push("picker");
      throw securityError;
    });
    vi.stubGlobal("window", { showSaveFilePicker });

    const client = await AutonomiClient.connect(endpoint);
    state.networks[0]!.downloadPublicFile.mockImplementation(async () => {
      events.push("download");
      return {
        content: Uint8Array.of(1, 2, 3),
        hash: file.blake3,
        file,
        dataMapNode: {
          peer_id: "77".repeat(32),
          native_addresses: [],
          reliability: 1,
        },
      };
    });

    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal(
      "setTimeout",
      vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
    );

    const result = await client.downloadAndSave(file.address);

    expect(events).toEqual(["picker", "download"]);
    expect(showSaveFilePicker).toHaveBeenCalledWith({});
    expect(result.save).toEqual({ method: "download", name: file.name });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
    client.close();
  });

  it("does not start downloading when the user cancels the save picker", async () => {
    const abortError = new Error("The user aborted a request");
    abortError.name = "AbortError";
    vi.stubGlobal("window", {
      showSaveFilePicker: vi.fn(async () => {
        throw abortError;
      }),
    });

    const client = await AutonomiClient.connect(endpoint);

    await expect(client.downloadAndSave(file)).rejects.toBe(abortError);
    expect(state.networks[0]!.downloadPublicFile).not.toHaveBeenCalled();
    client.close();
  });

  it("requires a payment provider before doing upload work", async () => {
    const client = await AutonomiClient.connect(endpoint);
    await expect(client.upload(new Uint8Array(3_072))).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
    expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
    client.close();
  });
});

describe("connection snapshots", () => {
  it("exposes frozen metadata and files without leaking operational configuration", async () => {
    const client = await AutonomiClient.connect(endpoint);
    const before = client.connection;
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.paymentNetwork)).toBe(true);
    expect(Object.isFrozen(before.bootstrap.endpoint)).toBe(true);
    expect(() => Object.assign(before.paymentNetwork, { rpc_url: "https://wrong.example" })).toThrow();
    state.networks[0]!.downloadPublicFile.mockResolvedValue({
      content: Uint8Array.of(1), hash: file.blake3, file: { ...file },
      dataMapNode: { peer_id: "aa".repeat(32), native_addresses: [], reliability: 1 },
    });
    const downloaded = await client.download(file.address);
    Object.assign(downloaded.file, { name: "changed by caller" });
    expect(client.files[0]!.name).toBe(file.name);
    expect(before.files).toHaveLength(0);
    expect(client.connection.files).toHaveLength(1);
    expect(Object.isFrozen(client.files[0]!.chunks)).toBe(true);
    client.close();
  });
});
