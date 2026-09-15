import type { ClientOptions, PaymentNetwork, WasmSource } from "./types.js";
import { getBindings, initializeClientWasm } from "./internal/runtime.js";
import { abortable, throwIfAborted } from "./internal/abort.js";
import type { CorePaymentNetwork } from "./internal/payment-network.js";
import { AutonomiError } from "./errors.js";

/** Application-bundled trust anchors. Never construct this from an untrusted manifest. */
export interface NetworkProfile {
  readonly id: string;
  readonly seeds: readonly string[];
  readonly payment: PaymentNetwork;
}

/** Rust-owned mainnet defaults. Seeds may be empty until browser nodes are deployed. */
export interface NetworkDefaults extends NetworkProfile {
  readonly rpcUrl: string;
}

export interface NetworkDefaultsOptions {
  wasm?: WasmSource | Promise<WasmSource>;
  signal?: AbortSignal;
}

/** Options for a named or application-configured network connection. */
export interface NetworkConnectionOptions extends Omit<ClientOptions, "expectedPaymentNetwork"> {
  /** Defaults to mainnet. A custom profile never falls back to mainnet. */
  network?: "mainnet" | NetworkProfile;
}

/** Read mainnet WebRTC seeds and payment defaults from the bundled Rust core. No network dial or EVM RPC. */
export async function getNetworkDefaults(options: NetworkDefaultsOptions = {}): Promise<NetworkDefaults> {
  throwIfAborted(options.signal);
  await abortable(initializeClientWasm(options.wasm), options.signal);
  throwIfAborted(options.signal);
  const raw = getBindings().mainnetNetworkDefaults() as {
    id: string; seeds: string[]; payment: CorePaymentNetwork; rpc_url: string;
  };
  return Object.freeze({
    id: raw.id,
    seeds: Object.freeze([...raw.seeds]),
    payment: Object.freeze({
      chainId: raw.payment.chain_id,
      paymentTokenAddress: raw.payment.payment_token_address,
      paymentVaultAddress: raw.payment.payment_vault_address,
    }),
    rpcUrl: raw.rpc_url,
  });
}

/** Copy a bundled profile before any asynchronous callbacks can alter it. */
export function snapshotNetworkProfile(profile: NetworkProfile): NetworkProfile {
  if (profile.seeds.length === 0) {
    throw new AutonomiError("CONNECTION_FAILED", `No WebRTC bootstrap seeds configured for ${profile.id}; supply a trusted network profile or an explicit WebRTC multiaddress`);
  }
  if (!profile.id || new Set(profile.seeds).size !== profile.seeds.length) {
    throw new TypeError("Network profiles require a name and distinct trusted seeds");
  }
  return Object.freeze({ id: profile.id, seeds: Object.freeze([...profile.seeds]), payment: Object.freeze({ ...profile.payment }) });
}
