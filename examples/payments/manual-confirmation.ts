import {
  createManualPaymentProvider,
  type AutonomiClient,
  type ManualPaymentRequest,
  type PaymentProvider,
  type UploadResult,
} from "@autonomi/browser-sdk";

interface PaymentElements {
  price: HTMLElement;
  status: HTMLElement;
  payButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

/**
 * Start quote collection immediately, then pause until the user clicks Pay.
 * `getWalletPayment` runs only when Pay is clicked, so the user can switch
 * wallet, account, or connector while reviewing the quotes.
 */
export async function uploadAfterQuoteAcceptance(
  client: AutonomiClient,
  file: File,
  getWalletPayment: () => PaymentProvider,
  elements: PaymentElements,
): Promise<UploadResult> {
  let pending: ManualPaymentRequest | undefined;
  const payment = createManualPaymentProvider({
    onRequest: (request) => {
      pending = request;
      elements.price.textContent =
        `${request.totalAmountAtto} atto-tokens across ${request.quotes.length} quotes`;
      elements.status.textContent = "Review the storage price before paying.";
      elements.payButton.disabled = false;
      elements.cancelButton.disabled = false;

      elements.payButton.onclick = () => {
        elements.payButton.disabled = true;
        elements.cancelButton.disabled = true;
        elements.status.textContent = "Confirm the payment in your wallet…";
        let selectedPayment: PaymentProvider;
        try {
          selectedPayment = getWalletPayment();
        } catch (error) {
          elements.status.textContent = `Select a wallet: ${errorMessage(error)}`;
          elements.payButton.disabled = false;
          elements.cancelButton.disabled = false;
          return;
        }
        void request.pay(selectedPayment).then(
          () => {
            elements.status.textContent = "Payment confirmed; uploading records…";
          },
          (error: unknown) => {
            elements.status.textContent = `Payment failed: ${errorMessage(error)}`;
            if (request.status === "pending") {
              elements.payButton.disabled = false;
              elements.cancelButton.disabled = false;
            }
          },
        );
      };
      elements.cancelButton.onclick = () => {
        request.cancel("User declined the storage price");
      };
    },
  });

  try {
    const result = await client.upload(file, { payment });
    elements.status.textContent = `Uploaded as ${result.file.address}`;
    return result;
  } finally {
    if (pending?.status === "pending") pending.cancel("Upload flow was closed");
    elements.payButton.onclick = null;
    elements.cancelButton.onclick = null;
    elements.payButton.disabled = true;
    elements.cancelButton.disabled = true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
