import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualPaymentRequest } from "../src/manual-payment.js";
import type {
  PaymentProvider,
  PublicFile,
  SaveFileHandle,
} from "../src/types.js";

const state = vi.hoisted(() => ({
  failedSeeds: [] as string[],
  attemptedSeeds: [] as string[],
  defaultSeeds: [] as string[],
  hello: {
    type: "hello",
    protocol: "autonomi.web.poc.v5",
    peer_id: "ab".repeat(32),
    endpoint: { multiaddr: "/ip4/127.0.0.1/udp/24000/mock" },
    max_chunk_size: 4_194_304,
    capabilities: ["get_chunk", "put_chunk", "chunk_protocol"],
    payment: {
      chain_id: 31337,
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
    reconcileFailedUploadPayment: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../src/internal/runtime.js", () => {
  class NodeClient {
    constructor(private endpoint: { multiaddr: string }) {}
    async connect() {
      state.attemptedSeeds.push(this.endpoint.multiaddr);
      if (state.failedSeeds.includes(this.endpoint.multiaddr)) throw new Error("Seed unavailable");
      return this;
    }
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
    reconcileFailedUploadPayment = vi.fn();

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
      mainnetNetworkDefaults: () => ({ id: "mainnet", seeds: state.defaultSeeds, payment: state.hello.payment, rpc_url: "https://rpc.example" }),
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
  UploadError,
  createManualPaymentProvider,
  SDK_LIMITS,
} from "../src/index.js";

const endpoint = "/ip4/127.0.0.1/udp/24000/webrtc-direct/mock";
const wireFile: import("../src/internal/protocol.js").CorePublicFile = {
  name: "hello.txt",
  address: "33".repeat(32),
  size: 12,
  content_type: "text/plain",
  blake3: "44".repeat(32),
  data_map_size: 100,
  chunks: [{ index: 0, dst_hash: "55".repeat(32), src_hash: "66".repeat(32), src_size: 12 }],
  replicas: 5,
};
const file: PublicFile = {
  name: "hello.txt", address: "33".repeat(32), size: 12, contentType: "text/plain",
  blake3: "44".repeat(32), dataMapSize: 100,
  chunks: [{ index: 0, dstHash: "55".repeat(32), srcHash: "66".repeat(32), srcSize: 12 }], replicas: 5,
};

beforeEach(() => {
  state.networks.length = 0;
  state.failedSeeds.length = 0;
  state.attemptedSeeds.length = 0;
  state.defaultSeeds.length = 0;
  state.hello.capabilities = ["get_chunk", "put_chunk", "chunk_protocol"];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: "0x7a69" })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AutonomiClient", () => {
  it("reports missing mainnet WebRTC seeds without dialing or accessing payment RPC", async () => {
    await expect(AutonomiClient.connect()).rejects.toMatchObject({
      code: "CONNECTION_FAILED", message: expect.stringContaining("No WebRTC bootstrap seeds configured for mainnet"),
    });
    expect(state.attemptedSeeds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses newly populated mainnet seeds with failover", async () => {
    const second = endpoint.replace("24000", "24001");
    state.defaultSeeds.push(endpoint, second);
    state.failedSeeds.push(endpoint);
    const client = await AutonomiClient.connect({ network: "mainnet" });
    expect(state.attemptedSeeds).toEqual([endpoint, second]);
    expect(fetch).not.toHaveBeenCalled();
    client.close();
    expect(state.networks.every(n => n.closed && n.freed)).toBe(true);
  });

  it("cancels a default connection before dialing", async () => {
    state.defaultSeeds.push(endpoint);
    const controller = new AbortController();
    controller.abort("stop");
    await expect(AutonomiClient.connect({ signal: controller.signal })).rejects.toBe("stop");
    expect(state.attemptedSeeds).toEqual([]);
  });

  it("keeps an empty custom profile authoritative even when mainnet has seeds", async () => {
    state.defaultSeeds.push(endpoint);
    await expect(AutonomiClient.connect({ network: { id: "devnet", seeds: [], payment: {
      chainId: 31337, paymentTokenAddress: `0x${"11".repeat(20)}`, paymentVaultAddress: `0x${"22".repeat(20)}`,
    } } })).rejects.toMatchObject({ code: "CONNECTION_FAILED", message: expect.stringContaining("devnet") });
    expect(state.attemptedSeeds).toEqual([]);
  });

  it("validates all custom seeds before dialing a valid first seed", async () => {
    await expect(AutonomiClient.connectNetwork({ id: "mixed", seeds: [endpoint, "/ip4/127.0.0.1/udp/10000/quic"], payment: {
      chainId: 31337, paymentTokenAddress: `0x${"11".repeat(20)}`, paymentVaultAddress: `0x${"22".repeat(20)}`,
    } })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(state.attemptedSeeds).toEqual([]);
  });

  it("authenticates a direct endpoint and derives its payment network", async () => {
    const progress: string[] = [];
    const client = await AutonomiClient.connect(endpoint, {
      onProgress: ({ message }) => progress.push(message),
    });

    expect(client.connection.bootstrap.peerId).toBe("ab".repeat(32));
    expect(client.connection.bootstrapMultiaddr).toBe(endpoint);
    expect(client.connection.paymentNetwork).toEqual({
      chainId: 31337, paymentTokenAddress: state.hello.payment.payment_token_address,
      paymentVaultAddress: state.hello.payment.payment_vault_address,
    });
    expect(client.connection.bootstrap.payment).toEqual(client.connection.paymentNetwork);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.connection.paymentNetwork).not.toHaveProperty("rpc_url");
    expect(state.networks[0]?.endpoints).toEqual([{ multiaddr: endpoint }]);
    expect(progress.at(-1)).toContain("Connected to authenticated peer");

    client.close();
    expect(state.networks[0]?.closed).toBe(true);
    expect(state.networks[0]?.freed).toBe(true);
    await expect(client.findClosest()).rejects.toBeInstanceOf(AutonomiError);
  });

  it("rejects nodes missing the shared storage protocol before creating a network client", async () => {
    state.hello.capabilities = ["get_chunk", "put_chunk"];
    await expect(AutonomiClient.connect(endpoint)).rejects.toMatchObject({
      code: "CONNECTION_FAILED", message: expect.stringContaining("chunk_protocol"),
    });
    expect(state.networks).toHaveLength(0);
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
      pay: vi.fn<PaymentProvider["pay"]>(async () => ({ totalAmount: "0" })),
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
        expect(paymentNetwork).toEqual(state.hello.payment);
        expect(paymentNetwork).not.toHaveProperty("chainId");
        await payForQuotes(paymentNetwork, [
          {
            quote: {},
            quoteHash: "55".repeat(32),
            rewardsAddress: `0x${"66".repeat(20)}`,
            amount: "42",
          },
        ]);
        return {
          file: wireFile,
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
    expect(payment.pay).toHaveBeenCalledWith(client.connection.paymentNetwork, expect.any(Array), expect.any(Object));
    expect(client.files).toContainEqual(file);
    client.close();
  });

  it("reports the payment mode the native coordinator used", async () => {
    const client = await AutonomiClient.connect(endpoint, { payment: { pay: async () => ({ totalAmount: "0" }) } });
    const upload = state.networks[0]!.uploadPublicFile;
    upload.mockResolvedValueOnce({ file: wireFile, storageCostAtto: "0", records: 4, paymentMode: "merkle" });
    await expect(client.upload(new Uint8Array(3_072), { paymentMode: "merkle" })).resolves.toMatchObject({ paymentMode: "merkle" });
    expect(upload.mock.calls[0]![8]).toBe("merkle");
    upload.mockResolvedValueOnce({ file: wireFile, storageCostAtto: "0", records: 4, paymentMode: "single" });
    await expect(client.upload(new Uint8Array(3_072))).resolves.toMatchObject({ paymentMode: "single" });
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
          file: wireFile,
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
      file: wireFile,
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
        file: wireFile,
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
      file: wireFile,
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
        file: wireFile,
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
  it("rejects an invalid node-advertised chain identity without fetching an RPC", async () => {
    const previous = state.hello.payment.chain_id;
    state.hello.payment.chain_id = -1;
    try {
      await expect(AutonomiClient.connect(endpoint)).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
      expect(state.networks).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { state.hello.payment.chain_id = previous; }
  });

  it("preserves cancellation before connection setup", async () => {
    const controller = new AbortController();
    controller.abort("cancel connection");
    await expect(AutonomiClient.connect(endpoint, { signal: controller.signal })).rejects.toBe("cancel connection");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.networks).toEqual([]);
  });

  it("exposes frozen metadata and files without leaking operational configuration", async () => {
    const client = await AutonomiClient.connect(endpoint);
    const before = client.connection;
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.paymentNetwork)).toBe(true);
    expect(Object.isFrozen(before.bootstrap.endpoint)).toBe(true);
    expect(() => Object.assign(before.paymentNetwork, { rpc_url: "https://wrong.example" })).toThrow();
    state.networks[0]!.downloadPublicFile.mockResolvedValue({
      content: Uint8Array.of(1), hash: file.blake3, file: { ...wireFile },
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

describe("structured operation progress", () => {
  it("correlates overlapping uploads and reports measured completion", async () => {
    const events: import("../src/types.js").ProgressEvent[] = [];
    const client = await AutonomiClient.connect(endpoint, {
      payment: { pay: async () => ({ totalAmount: "0" }) },
      onProgress: (event) => events.push(event),
    });
    state.networks[0]!.uploadPublicFile.mockImplementation(async (_bytes, name, _type, _network, _pay, report) => {
      report("An opaque Rust diagnostic");
      await Promise.resolve();
      return { file: { ...wireFile, name }, storageCostAtto: "0", records: 1 };
    });
    await Promise.all([
      client.upload(Uint8Array.of(1, 2, 3), { name: "first" }),
      client.upload(Uint8Array.of(2, 3, 4), { name: "second" }),
    ]);
    const uploads = events.filter((event) => event.operation === "upload");
    const ids = new Set(uploads.map((event) => event.operationId));
    expect(ids.size).toBe(2);
    for (const id of ids) {
      const group = uploads.filter((event) => event.operationId === id);
      expect(group[0]!.phase).toBe("preparing");
      expect(group.at(-1)).toMatchObject({ phase: "complete", completed: file.size, total: file.size, unit: "bytes" });
      expect(Object.isFrozen(group[0])).toBe(true);
    }
    client.close();
  });
  it("checks abort after notifying listeners before starting upload work", async () => {
    const client = await AutonomiClient.connect(endpoint, { payment: { pay: async () => ({ totalAmount: "0" }) } });
    const controller = new AbortController();
    await expect(client.upload(Uint8Array.of(1, 2, 3), {
      signal: controller.signal, onProgress: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
    client.close();
  });
});

const recoveryQuotes = [
  { quote: {}, quoteHash: "55".repeat(32), rewardsAddress: `0x${"66".repeat(20)}`, amount: "40" },
  { quote: {}, quoteHash: "77".repeat(32), rewardsAddress: `0x${"66".repeat(20)}`, amount: "2" },
];
const successfulUpload = { file: wireFile, transactionHash: "0xpayment", storageCostAtto: "42", records: 4 };
const recoveryPayment = (): PaymentProvider => ({
  pay: vi.fn<PaymentProvider["pay"]>(async (_network, quotes) => ({
    transactionHash: "0xpayment",
    totalAmount: quotes.reduce((sum, quote) => sum + BigInt(quote.amount), 0n).toString(),
  })),
});
function paidThenFailed(network: (typeof state.networks)[number]) {
  network.uploadPublicFile.mockImplementationOnce(async (_bytes, _name, _type, paymentNetwork, pay) => {
    await pay(paymentNetwork, recoveryQuotes);
    throw new Error("storage quorum failed after payment");
  });
}

describe("upload recovery", () => {
  it("retains immutable receipts and retries owned bytes without paying twice", async () => {
    const payment = recoveryPayment();
    const client = await AutonomiClient.connect(endpoint, { payment });
    const network = state.networks[0]!;
    paidThenFailed(network);
    const bytes = Uint8Array.of(1, 2, 3);
    const failure = await client.upload(bytes).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UploadError);
    const recovery = (failure as UploadError).recovery;
    expect(client.pendingUploads).toEqual([recovery]);
    await recovery.settled;
    bytes.fill(9);
    expect(recovery.payments[0]!.receipt.totalAmount).toBe("42");
    expect(Object.isFrozen(recovery.payments[0]!.quotes[0])).toBe(true);
    network.uploadPublicFile.mockImplementationOnce(async (retried, _name, _type, paymentNetwork, pay) => {
      expect(retried).toEqual(Uint8Array.of(1, 2, 3));
      expect(await pay(paymentNetwork, recoveryQuotes)).toMatchObject({ transactionHash: "0xpayment", totalAmount: "42" });
      return successfulUpload;
    });
    const result = await client.resumeUpload(recovery);
    expect(payment.pay).toHaveBeenCalledOnce();
    expect(result.payments).toHaveLength(1);
    expect(result.storageCostAtto).toBe("42");
    expect(recovery.status).toBe("completed");
    expect(client.pendingUploads).toEqual([]);
    client.close();
  });
  it("requires explicit authorization for new quotes and includes every payment in the result", async () => {
    const payment = recoveryPayment();
    const client = await AutonomiClient.connect(endpoint, { payment });
    const network = state.networks[0]!;
    paidThenFailed(network);
    await expect(client.upload(Uint8Array.of(1, 2, 3))).rejects.toBeInstanceOf(UploadError);
    const recovery = client.pendingUploads[0]!;
    const changed = [{ ...recoveryQuotes[0]!, quoteHash: "88".repeat(32), amount: "43" }];
    network.uploadPublicFile.mockImplementation(async (_bytes, _name, _type, paymentNetwork, pay) => {
      await pay(paymentNetwork, changed);
      return successfulUpload;
    });
    await expect(client.resumeUpload(recovery)).rejects.toMatchObject({ code: "RECOVERY_PAYMENT_REQUIRED", recovery });
    expect(payment.pay).toHaveBeenCalledOnce();
    const result = await client.resumeUpload(recovery, { payment });
    expect(payment.pay).toHaveBeenCalledTimes(2);
    expect(result.payments).toHaveLength(2);
    expect(result.storageCostAtto).toBe("85");
    client.close();
  });
  it("reuses a payment covering only the remaining subset of quotes", async () => {
    const payment = recoveryPayment();
    const client = await AutonomiClient.connect(endpoint, { payment });
    const network = state.networks[0]!;
    paidThenFailed(network);
    await expect(client.upload(Uint8Array.of(1, 2, 3))).rejects.toBeInstanceOf(UploadError);
    network.uploadPublicFile.mockImplementationOnce(async (_bytes, _name, _type, paymentNetwork, pay) => {
      expect(await pay(paymentNetwork, [recoveryQuotes[1]!])).toMatchObject({ transactionHash: "0xpayment", totalAmount: "2" });
      return successfulUpload;
    });
    const result = await client.resumeUpload(client.pendingUploads[0]!);
    expect(result.storageCostAtto).toBe("42");
    expect(payment.pay).toHaveBeenCalledOnce();
    client.close();
  });
  it("captures a payment confirming after cancellation and resumes on a replacement client", async () => {
    let confirm!: (receipt: { transactionHash: string; totalAmount: string }) => void;
    const payment: PaymentProvider = { pay: vi.fn<PaymentProvider["pay"]>(() => new Promise((resolve) => { confirm = resolve; })) };
    const client = await AutonomiClient.connect(endpoint, { payment });
    paidThenFailed(state.networks[0]!);
    const controller = new AbortController();
    const upload = client.upload(Uint8Array.of(1, 2, 3), { signal: controller.signal });
    const failure = expect(upload).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(payment.pay).toHaveBeenCalledOnce());
    controller.abort(); await failure;
    const recovery = client.pendingUploads[0]!;
    expect(recovery.status).toBe("settling");
    expect(recovery.payments).toEqual([]);
    client.close();
    const replacement = await AutonomiClient.connect(endpoint);
    state.networks[1]!.uploadPublicFile.mockImplementation(async (_bytes, _name, _type, paymentNetwork, pay) => {
      await pay(paymentNetwork, recoveryQuotes); return successfulUpload;
    });
    const resumed = replacement.resumeUpload(recovery);
    await Promise.resolve();
    expect(state.networks[1]!.uploadPublicFile).not.toHaveBeenCalled();
    confirm({ transactionHash: "0xpayment", totalAmount: "42" });
    await expect(resumed).resolves.toMatchObject({ storageCostAtto: "42" });
    expect(recovery.payments).toHaveLength(1);
    expect(payment.pay).toHaveBeenCalledOnce();
    expect(client.pendingUploads).toEqual([]);
    replacement.close();
  });
  it("returns a late successful upload without sending its records again", async () => {
    const client = await AutonomiClient.connect(endpoint, { payment: recoveryPayment() });
    const network = state.networks[0]!;
    let complete!: (result: typeof successfulUpload) => void;
    network.uploadPublicFile.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const upload = client.upload(Uint8Array.of(1, 2, 3), { signal: controller.signal });
    const failure = expect(upload).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await failure;
    const recovery = client.pendingUploads[0]!;
    complete(successfulUpload);
    await recovery.settled;
    await expect(client.resumeUpload(recovery)).resolves.toMatchObject({ file });
    expect(network.uploadPublicFile).toHaveBeenCalledOnce();
    client.close();
  });
  it("prevents concurrent resumes and makes discard idempotent", async () => {
    const client = await AutonomiClient.connect(endpoint, { payment: recoveryPayment() });
    const network = state.networks[0]!;
    paidThenFailed(network);
    await expect(client.upload(Uint8Array.of(1, 2, 3))).rejects.toBeInstanceOf(UploadError);
    const recovery = client.pendingUploads[0]!;
    let fail!: (error: Error) => void;
    network.uploadPublicFile.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    const first = client.resumeUpload(recovery);
    const failure = expect(first).rejects.toBeInstanceOf(UploadError);
    await vi.waitFor(() => expect(network.uploadPublicFile).toHaveBeenCalledTimes(2));
    await expect(client.resumeUpload(recovery)).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS" });
    await expect(recovery.discard()).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS" });
    fail(new Error("network unavailable")); await failure;
    await recovery.discard(); await recovery.discard();
    expect(recovery.status).toBe("discarded");
    expect(client.pendingUploads).toEqual([]);
    await expect(client.resumeUpload(recovery)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    client.close();
  });
});

it("cancels a resume waiting for settlement without claiming or discarding its input", async () => {
  const client = await AutonomiClient.connect(endpoint, { payment: recoveryPayment() });
  const network = state.networks[0]!;
  let fail!: (error: Error) => void;
  network.uploadPublicFile.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
  const firstController = new AbortController();
  const upload = client.upload(Uint8Array.of(1, 2, 3), { signal: firstController.signal });
  const failed = expect(upload).rejects.toMatchObject({ name: "AbortError" });
  firstController.abort(); await failed;
  const recovery = client.pendingUploads[0]!;
  const controller = new AbortController();
  const resumed = client.resumeUpload(recovery, { signal: controller.signal });
  const cancelled = expect(resumed).rejects.toMatchObject({ name: "AbortError" });
  controller.abort(); await cancelled;
  expect(network.uploadPublicFile).toHaveBeenCalledOnce();
  expect(recovery.status).toBe("settling");
  fail(new Error("original operation stopped"));
  await recovery.settled;
  expect(recovery.status).toBe("ready");
  await recovery.discard();
  client.close();
});

it.each([
  { chainId: 1 },
  { paymentTokenAddress: `0x${"aa".repeat(20)}` },
  { paymentVaultAddress: `0x${"bb".repeat(20)}` },
])("rejects authenticated metadata outside the application's network policy: %o", async (changed) => {
  const expectedPaymentNetwork = { chainId: state.hello.payment.chain_id,
    paymentTokenAddress: state.hello.payment.payment_token_address,
    paymentVaultAddress: state.hello.payment.payment_vault_address, ...changed };
  await expect(AutonomiClient.connect(endpoint, { expectedPaymentNetwork })).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  expect(state.networks).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("copies the expected identity before setup and connects without an RPC", async () => {
  const expectedPaymentNetwork = { chainId: state.hello.payment.chain_id,
    paymentTokenAddress: state.hello.payment.payment_token_address.toUpperCase(),
    paymentVaultAddress: state.hello.payment.payment_vault_address };
  const client = await AutonomiClient.connect(endpoint, { expectedPaymentNetwork,
    onProgress: () => { expectedPaymentNetwork.chainId = 1; },
  });
  expect(client.connection.paymentNetwork.chainId).toBe(31337);
  expect(fetch).not.toHaveBeenCalled();
  client.close();
});

it("rejects an incomplete network policy before initializing a connection", async () => {
  await expect(AutonomiClient.connect(endpoint, {
    // @ts-expect-error A pinned network includes both contracts, not only the chain.
    expectedPaymentNetwork: { chainId: 1 },
  })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(state.networks).toHaveLength(0);
});

describe("terminal operation events", () => {
  it("emits a single failure with the promise's error for early validation", async () => {
    const client = await AutonomiClient.connect(endpoint);
    for (const run of [
      (onProgress: import("../src/types.js").ProgressListener) => client.upload(Uint8Array.of(1, 2, 3), { onProgress }),
      (onProgress: import("../src/types.js").ProgressListener) => client.download(file, { concurrency: 0, onProgress }),
    ]) {
      const events: import("../src/types.js").ProgressEvent[] = [];
      const error = await run((event) => events.push(event)).catch((error: unknown) => error);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "failed", error });
    }
    client.close();
    const onProgress = vi.fn();
    await expect(client.findClosest(file.address, { onProgress })).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: expect.objectContaining({ code: "CLIENT_CLOSED" }) }));
  });

  it("reports cancellation with direct recovery ownership and ignores late diagnostics", async () => {
    const events: import("../src/types.js").ProgressEvent[] = [];
    const client = await AutonomiClient.connect(endpoint, { payment: recoveryPayment(), onProgress: (event) => events.push(event) });
    let rejectWork!: (error: unknown) => void;
    let diagnostic!: (message: string) => void;
    state.networks[0]!.uploadPublicFile.mockImplementation((_bytes, _name, _type, _network, _pay, report) => {
      diagnostic = report;
      return new Promise((_resolve, reject) => { rejectWork = reject; });
    });
    const uploading = client.upload(Uint8Array.of(1, 2, 3));
    const rejected = expect(uploading).rejects.toMatchObject({ name: "AbortError" });
    client.close();
    await rejected;
    const terminal = events.filter((event) => event.operation === "upload" && event.status !== "running");
    expect(terminal).toHaveLength(1);
    const recovery = client.pendingUploads[0]!;
    expect(terminal[0]).toMatchObject({ status: "cancelled", operationId: recovery.id, recovery });
    diagnostic("late progress");
    expect(events.filter((event) => event.message === "late progress")).toEqual([]);
    rejectWork(new Error("network closed"));
    await recovery.discard();
  });

  it("correlates download and save children with one successful parent", async () => {
    const client = await AutonomiClient.connect(endpoint);
    state.networks[0]!.downloadPublicFile.mockResolvedValue({ content: Uint8Array.of(1), hash: file.blake3, file: wireFile,
      dataMapNode: { peer_id: "aa".repeat(32), native_addresses: [], reliability: 1 } });
    const events: import("../src/types.js").ProgressEvent[] = [];
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    await client.downloadAndSave(file, { parentOperationId: "application-task", onProgress: (event) => events.push(event),
      fileHandle: { createWritable: async () => writable } });
    const terminals = events.filter((event) => event.status !== "running");
    expect(terminals.map((event) => event.operation)).toEqual(["download", "save", "download-and-save"]);
    expect(terminals.every((event) => event.status === "succeeded")).toBe(true);
    const parent = terminals[2]!;
    expect(parent.parentOperationId).toBe("application-task");
    expect(terminals.slice(0, 2).map((event) => event.parentOperationId)).toEqual([parent.operationId, parent.operationId]);
    client.close();
  });

  it("ends both media setup and its open-file child when opening fails", async () => {
    const events: import("../src/types.js").ProgressEvent[] = [];
    const onProgress = (event: import("../src/types.js").ProgressEvent) => events.push(event);
    const client = await AutonomiClient.connect(endpoint, { onProgress });
    events.length = 0;
    await expect(client.createMediaSource(file, { onProgress })).rejects.toMatchObject({ code: "OPEN_FILE_FAILED" });
    const terminal = events.filter((event) => event.status !== "running");
    expect(terminal.map((event) => event.operation)).toEqual(["open-file", "media"]);
    expect(terminal[0]!.parentOperationId).toBe(terminal[1]!.operationId);
    expect(terminal.every((event) => event.status === "failed")).toBe(true);
    client.close();
  });

  it("reports a cancelled connection even when its signal was already aborted", async () => {
    const controller = new AbortController(); controller.abort("stop");
    const onProgress = vi.fn();
    await expect(AutonomiClient.connect(endpoint, { onProgress, signal: controller.signal })).rejects.toBe("stop");
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", error: "stop" }));
  });
});

it("fails the composed operation when saving fails after a successful download", async () => {
  const client = await AutonomiClient.connect(endpoint);
  state.networks[0]!.downloadPublicFile.mockResolvedValue({ content: Uint8Array.of(1), hash: file.blake3, file: wireFile,
    dataMapNode: { peer_id: "aa".repeat(32), native_addresses: [], reliability: 1 } });
  const events: import("../src/types.js").ProgressEvent[] = [];
  const error = await client.downloadAndSave(file, { onProgress: (event) => events.push(event),
    fileHandle: { createWritable: async () => { throw new Error("disk full"); } },
  }).catch((error: unknown) => error);
  const terminal = events.filter((event) => event.status !== "running");
  expect(terminal.map((event) => [event.operation, event.status])).toEqual([
    ["download", "succeeded"], ["save", "failed"], ["download-and-save", "failed"],
  ]);
  expect(terminal[1]).toMatchObject({ error });
  expect(terminal[2]).toMatchObject({ error });
  client.close();
});

it("translates public file metadata into the existing wire format for downloads and readers", async () => {
  const client = await AutonomiClient.connect(endpoint);
  const raw = state.networks[0]!;
  const rawNode = { peer_id: "77".repeat(32), native_addresses: ["/native"], reliability: 1, webrtc_direct: { multiaddr: endpoint } };
  raw.downloadPublicFile.mockResolvedValue({ content: Uint8Array.of(1), hash: file.blake3, file: wireFile, dataMapNode: rawNode });
  const downloaded = await client.download(file);
  expect(raw.downloadPublicFile).toHaveBeenCalledWith({ address: file.address, name: file.name, content_type: file.contentType }, undefined, expect.any(Function));
  expect(downloaded.file).toEqual(file);
  expect(downloaded.dataMapNode).toEqual({ peerId: rawNode.peer_id, nativeAddresses: ["/native"], reliability: 1, webrtcDirect: { multiaddr: endpoint } });
  expect(downloaded.file).not.toHaveProperty("content_type");
  expect(client.connection.bootstrap).not.toHaveProperty("peer_id");
  expect(client.connection.bootstrap.maxChunkSize).toBe(state.hello.max_chunk_size);
  raw.openPublicFile.mockResolvedValue({ size: file.size, name: file.name, contentType: file.contentType,
    readRange: vi.fn(), close: vi.fn(), free: vi.fn() });
  const reader = await client.openFile(file);
  expect(raw.openPublicFile).toHaveBeenCalledWith({ address: file.address, name: file.name, content_type: file.contentType }, expect.any(Function));
  reader.close();
  raw.findClosest.mockResolvedValue({ nodes: [rawNode], queried: ["peer"], failures: [{ peerId: "failed-peer", message: "timeout" }] } as never);
  expect(await client.findClosest(file.address)).toEqual({ nodes: [downloaded.dataMapNode], queried: ["peer"], failures: [{ peerId: "failed-peer", message: "timeout" }] });
  client.close();
});

it("rejects unsupported file sizes before copying, staging, or opening the network", async () => {
  const client = await AutonomiClient.connect(endpoint, { payment: recoveryPayment() });
  const tooSmall = new Uint8Array(SDK_LIMITS.minFileBytes - 1);
  const copy = vi.spyOn(tooSmall, "slice");
  await expect(client.upload(tooSmall)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(copy).not.toHaveBeenCalled();
  const tooLarge = new Blob(["abc"]);
  Object.defineProperty(tooLarge, "size", { value: SDK_LIMITS.maxFileBytes + 1 });
  await expect(client.upload(tooLarge)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
  expect(state.networks[0]!.uploadStagedPublicFile).not.toHaveBeenCalled();
  expect(state.networks[0]!.downloadPublicFile).not.toHaveBeenCalled();
  expect(state.networks[0]!.openPublicFile).not.toHaveBeenCalled();
  expect(client.pendingUploads).toEqual([]);
  client.close();
});

it("accepts the advertised concurrency bounds and rejects values outside them", async () => {
  const client = await AutonomiClient.connect(endpoint);
  const download = state.networks[0]!.downloadPublicFile;
  download.mockResolvedValue({ content: Uint8Array.of(1), hash: file.blake3, file: wireFile,
    dataMapNode: { peer_id: "aa".repeat(32), native_addresses: [], reliability: 1 } });
  for (const concurrency of [SDK_LIMITS.downloadConcurrency.min, SDK_LIMITS.downloadConcurrency.max]) {
    await client.download(file, { concurrency });
    expect(download).toHaveBeenLastCalledWith({ address: file.address, name: file.name, content_type: file.contentType }, concurrency, expect.any(Function));
  }
  for (const concurrency of [SDK_LIMITS.downloadConcurrency.min - 1, SDK_LIMITS.downloadConcurrency.max + 1, 1.5, NaN, Infinity]) {
    await expect(client.download(file, { concurrency })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  }
  expect(download).toHaveBeenCalledTimes(2);
  for (const options of [{}, { concurrency: "auto" as const }]) {
    await client.download(file, options);
    expect(download).toHaveBeenLastCalledWith({ address: file.address, name: file.name, content_type: file.contentType }, undefined, expect.any(Function));
  }
  client.close();
});

it("derives read size from the DataMap rather than a supplied descriptor", async () => {
  const client = await AutonomiClient.connect(endpoint);
  const download = state.networks[0]!.downloadPublicFile;
  download.mockResolvedValue({ content: Uint8Array.of(1), hash: file.blake3, file: wireFile,
    dataMapNode: { peer_id: "aa".repeat(32), native_addresses: [], reliability: 1 } });
  await client.download({ ...file, size: Number.MAX_SAFE_INTEGER, chunks: [], blake3: "invalid hint" });
  expect(download).toHaveBeenCalledWith({ address: file.address, name: file.name, content_type: file.contentType }, undefined, expect.any(Function));
  client.close();
});

for (const withSubmission of [false, true]) it(`journals malformed wallet evidence before validation (submission: ${withSubmission})`, async () => {
  const receipt = { transactionHash: `0x${"ab".repeat(32)}`, totalAmount: "wrong" };
  const provider: PaymentProvider = { pay: vi.fn(async (_network, _quotes, context) => {
    if (withSubmission) context.submitted({ ...receipt, wait: async () => ({ status: "confirmed", receipt }) });
    return receipt;
  }) };
  const client = await AutonomiClient.connect(endpoint, { payment: provider });
  const evidence: unknown[] = [];
  state.networks[0]!.uploadPublicFile.mockImplementation(async (...args: unknown[]) => {
    const pay = args[4] as (network: unknown, quotes: unknown, persist: (value: unknown) => Promise<void>) => Promise<unknown>;
    return pay(state.hello.payment, recoveryQuotes, async value => { evidence.push(value); });
  });
  try {
    await expect(client.upload(new Uint8Array(100))).rejects.toBeInstanceOf(UploadError);
    expect(evidence).toContainEqual(expect.objectContaining(receipt));
    expect(provider.pay).toHaveBeenCalledTimes(1);
  } finally { client.close(); }
});

it("fails over between trusted seeds and retains the complete profile for lookup", async () => {
  const second = endpoint.replace("24000", "24001");
  state.failedSeeds.push(endpoint);
  const profile = { id: "test", seeds: [endpoint, second], payment: {
    chainId: state.hello.payment.chain_id,
    paymentTokenAddress: state.hello.payment.payment_token_address,
    paymentVaultAddress: state.hello.payment.payment_vault_address,
  } };
  const client = await AutonomiClient.connectNetwork(profile);
  try {
    expect(state.attemptedSeeds).toEqual([endpoint, second]);
    expect(client.connection.bootstrapMultiaddr).toBe(second);
    expect(state.networks.at(-1)!.endpoints).toEqual(profile.seeds.map(multiaddr => ({ multiaddr })));
    expect(state.networks[0]!.freed).toBe(true);
  } finally { client.close(); }
});

it("rejects every seed with a payment identity outside the bundled profile", async () => {
  await expect(AutonomiClient.connectNetwork({ id: "wrong-chain", seeds: [endpoint, endpoint.replace("24000", "24001")], payment: {
    chainId: 1, paymentTokenAddress: state.hello.payment.payment_token_address,
    paymentVaultAddress: state.hello.payment.payment_vault_address,
  } })).rejects.toThrow(/does not match/);
  expect(state.attemptedSeeds).toHaveLength(2);
  expect(state.networks).toHaveLength(0);
});

it("delegates failed payment reconciliation to Rust and awaits durable persistence", async () => {
  const payment = { pay: vi.fn() };
  const client = await AutonomiClient.connect(endpoint, { payment });
  const attempt = { submissions: [{ transactionHash: "0x123" }] };
  const resolution = { status: "reverted" as const, transactionHashes: ["0x123"], evidence: { finalized: true } };
  let persisted = false;
  const verifyFailure = vi.fn(async () => resolution);
  const onCheckpoint = vi.fn(async () => {
    await Promise.resolve();
    persisted = true;
  });
  state.networks[0]!.reconcileFailedUploadPayment.mockImplementation(async (checkpoint, verify, save) => {
    expect(checkpoint).toBe("original journal");
    expect(await verify(attempt, "native scope")).toEqual(resolution);
    await save("reconciled journal");
    return "reconciled journal";
  });
  await expect(client.reconcileFailedUploadPayment("original journal", { verifyFailure, onCheckpoint }))
    .resolves.toBe("reconciled journal");
  expect(verifyFailure).toHaveBeenCalledExactlyOnceWith(attempt, "native scope");
  expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith("reconciled journal");
  expect(persisted).toBe(true);
  expect(payment.pay).not.toHaveBeenCalled();
  expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
  client.close();
});

it("propagates native verification and persistence failures without authorizing payment", async () => {
  const client = await AutonomiClient.connect(endpoint);
  for (const reason of ["reverted transaction hashes must cover every journaled transaction", "disk full"]) {
    state.networks[0]!.reconcileFailedUploadPayment.mockRejectedValueOnce(new Error(reason));
    await expect(client.reconcileFailedUploadPayment("original journal", {
      verifyFailure: () => ({ status: "notSubmitted", evidence: { walletRequest: "never started" } }),
      onCheckpoint: vi.fn(),
    })).rejects.toThrow(reason);
  }
  expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
  client.close();
});
