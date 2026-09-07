import { expect, expectTypeOf, it } from "vitest";
import type { NoPaymentReceipt, PaidPaymentReceipt, PaymentReceipt } from "../src/index.js";
import { validateReceipt } from "../src/internal/upload-recovery.js";

const quote = { quote: {}, quoteHash: "ab".repeat(32), rewardsAddress: `0x${"cd".repeat(20)}`, amount: "42" };

it("requires a transaction hash for paid receipts at the type boundary", () => {
  const paid: PaidPaymentReceipt = { transactionHash: "0xpaid", totalAmount: "42" };
  const empty: NoPaymentReceipt = { totalAmount: "0" };
  expectTypeOf(paid).toMatchTypeOf<PaymentReceipt>();
  expectTypeOf(empty).toMatchTypeOf<PaymentReceipt>();
  expectTypeOf<{ totalAmount: "42" }>().not.toMatchTypeOf<PaymentReceipt>();
  expectTypeOf<{ totalAmount: "0"; transactionHash: string }>().not.toMatchTypeOf<NoPaymentReceipt>();
});

it.each([undefined, "", "   ", 123])("rejects an invalid paid hash from JavaScript: %s", (transactionHash) => {
  const receipt = { transactionHash, totalAmount: "42" } as unknown as PaymentReceipt;
  expect(() => validateReceipt(receipt, [quote])).toThrow("transactionHash");
});

it("distinguishes empty plans from zero-token transactions", () => {
  expect(() => validateReceipt({ totalAmount: "0" }, [])).not.toThrow();
  expect(() => validateReceipt({ totalAmount: "0" }, [{ ...quote, amount: "0" }])).toThrow("transactionHash");
  expect(() => validateReceipt({ transactionHash: "0xpaid", totalAmount: "0" }, [{ ...quote, amount: "0" }])).not.toThrow();
  expect(() => validateReceipt({ transactionHash: "0xpaid", totalAmount: "41" }, [quote])).toThrow("totalAmount");
});
