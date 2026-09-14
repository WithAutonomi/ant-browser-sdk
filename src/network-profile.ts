import type { PaymentNetwork } from "./types.js";

/** Application-bundled trust anchors. Never construct this from an untrusted manifest. */
export interface NetworkProfile {
  readonly id: string;
  readonly seeds: readonly string[];
  readonly payment: PaymentNetwork;
}

/** Copy a bundled profile before any asynchronous callbacks can alter it. */
export function snapshotNetworkProfile(profile: NetworkProfile): NetworkProfile {
  if (!profile.id || profile.seeds.length < 2 || new Set(profile.seeds).size !== profile.seeds.length) {
    throw new TypeError("Network profiles require a name and at least two distinct trusted seeds");
  }
  return Object.freeze({ id: profile.id, seeds: Object.freeze([...profile.seeds]), payment: Object.freeze({ ...profile.payment }) });
}
