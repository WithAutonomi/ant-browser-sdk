import { expect, it } from "vitest";
import { snapshotNetworkProfile } from "../src/network-profile.js";
it("copies bundled trust settings before asynchronous connection callbacks", () => {
  const source = { id: "test", seeds: ["first", "second"], payment: { chainId: 1, paymentTokenAddress: "token", paymentVaultAddress: "vault" } };
  const profile = snapshotNetworkProfile(source);
  source.seeds[0] = "replacement"; source.payment.chainId = 2;
  expect(profile.seeds).toEqual(["first", "second"]); expect(profile.payment.chainId).toBe(1);
  expect(() => snapshotNetworkProfile({ ...source, seeds: ["first", "first"] })).toThrow(/distinct/);
});
