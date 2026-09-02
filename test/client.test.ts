import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualPaymentRequest } from "../src/manual-payment.js";
import type { PaymentProvider, PublicFile } from "../src/types.js";

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
    uploadPublicFile: ReturnType<typeof vi.fn>;
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
    uploadPublicFile = vi.fn();
    downloadPublicFile = vi.fn();

    constructor(endpoints: unknown) {
      this.endpoints = endpoints;
      state.networks.push(this);
    }

    async findClosest(): Promise<unknown> {
      return { nodes: [], queried: [], failures: [] };
    }
    async openPublicFile(): Promise<never> {
      throw new Error("not used");
    }
    async uploadStagedPublicFile(): Promise<never> {
      throw new Error("not used");
    }
    close(): void {
      this.closed = true;
    }
    free(): void {
      this.freed = true;
    }
  }

  return {
    initializeWasm: vi.fn(async () => undefined),
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

  it("requires a payment provider before doing upload work", async () => {
    const client = await AutonomiClient.connect(endpoint);
    await expect(client.upload(new Uint8Array(3_072))).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
    expect(state.networks[0]!.uploadPublicFile).not.toHaveBeenCalled();
    client.close();
  });
});
