import { expect, it, vi } from "vitest";
import { createPaymentSubmission } from "../src/payment.js";

it("shares confirmation attempts, retries observation failures, and caches the outcome", async () => {
  const receipt = { transactionHash: "0xrepriced", totalAmount: "42" };
  const observe = vi.fn().mockRejectedValueOnce(new Error("RPC timeout"))
    .mockResolvedValue({ status: "confirmed", receipt });
  const submission = createPaymentSubmission({ transactionHash: "0xoriginal", totalAmount: "42" }, observe);
  const first = submission.wait();
  expect(submission.wait()).toBe(first);
  await expect(first).rejects.toThrow("RPC timeout");
  const outcome = await submission.wait();
  receipt.totalAmount = "99";
  expect(await submission.wait()).toBe(outcome);
  expect(outcome).toEqual({ status: "confirmed", receipt: { transactionHash: "0xrepriced", totalAmount: "42" } });
  expect(Object.isFrozen(submission)).toBe(true);
  expect(observe).toHaveBeenCalledTimes(2);
});

it("caches definitive failure without submitting or observing again", async () => {
  const observe = vi.fn(async () => ({ status: "failed" as const, reason: "reverted" }));
  const submission = createPaymentSubmission({ transactionHash: "0xoriginal", totalAmount: "0" }, observe);
  await expect(submission.wait()).resolves.toEqual({ status: "failed", reason: "reverted" });
  await submission.wait();
  expect(observe).toHaveBeenCalledOnce();
});
