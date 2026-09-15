import {
  AutonomiClient,
  createManualPaymentProvider,
  type ManualPaymentRequest,
  type PaymentProvider,
} from "@autonomi/browser-sdk";
import { createEthersPaymentProvider } from "@autonomi/browser-sdk/ethers";
import {
  connectInjectedWallet,
  connectedEthersPaymentProvider,
} from "../shared/ethers-wallet.js";
import "../shared/style.css";
import { createLogger, element, errorMessage } from "../shared/ui.js";

const bootstrap = element<HTMLInputElement>("bootstrap");
const fileInput = element<HTMLInputElement>("file");
const privateKey = element<HTMLInputElement>("private-key");
const paymentRpc = element<HTMLInputElement>("payment-rpc");
const walletMode = element<HTMLSelectElement>("wallet-mode");
const injectedFields = element<HTMLElement>("injected-fields");
const privateKeyFields = element<HTMLElement>("private-key-fields");
const connection = element<HTMLOutputElement>("connection");
const walletState = element<HTMLOutputElement>("wallet-state");
const quotePanel = element<HTMLElement>("quote-panel");
const price = element<HTMLOutputElement>("price");
const quoteList = element<HTMLUListElement>("quotes");
const paymentState = element<HTMLOutputElement>("payment-state");
const connectButton = element<HTMLButtonElement>("connect");
const connectWalletButton = element<HTMLButtonElement>("connect-wallet");
const quoteButton = element<HTMLButtonElement>("quote");
const payButton = element<HTMLButtonElement>("pay");
const cancelButton = element<HTMLButtonElement>("cancel");
const { write, writeError } = createLogger(element<HTMLPreElement>("log"));

let client: AutonomiClient | undefined;
let pending: ManualPaymentRequest | undefined;

walletMode.addEventListener("change", refreshWalletControls);
refreshWalletControls();

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    client?.close();
    client = await AutonomiClient.connect(bootstrap.value.trim(), {
      onProgress: ({ operation, message }) => write(`[${operation}] ${message}`),
    });
    connection.value = `Connected to ${client.connection.bootstrap.peerId.slice(0, 16)}…`;
    quoteButton.disabled = false;
  } catch (error) {
    client = undefined;
    connection.value = "Connection failed";
    quoteButton.disabled = true;
    writeError(error);
  } finally {
    connectButton.disabled = false;
  }
});

connectWalletButton.addEventListener("click", async () => {
  connectWalletButton.disabled = true;
  try {
    walletState.value = `Connected as ${await connectInjectedWallet()}`;
  } catch (error) {
    walletState.value = "Wallet connection failed";
    writeError(error);
  } finally {
    connectWalletButton.disabled = false;
  }
});

quoteButton.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!client || !file) {
    write("Connect to a node and choose a file first.");
    return;
  }
  quoteButton.disabled = true;
  connectButton.disabled = true;
  quotePanel.classList.add("hidden");
  paymentState.value = "Collecting and verifying storage quotes…";

  const payment = createManualPaymentProvider({
    onRequest: (request) => {
      pending = request;
      showQuotes(request);
      payButton.onclick = () => payPendingRequest(request);
      cancelButton.onclick = () => {
        request.cancel("User declined the storage price");
      };
    },
  });

  try {
    const uploaded = await client.upload(file, { payment, paymentMode: "single" });
    paymentState.value = `Uploaded as ${uploaded.file.address}`;
  } catch (error) {
    paymentState.value =
      pending?.status === "cancelled"
        ? "Upload cancelled before payment."
        : `Upload failed: ${errorMessage(error)}`;
    writeError(error);
  } finally {
    if (pending?.status === "pending") pending.cancel("Upload flow was closed");
    pending = undefined;
    payButton.onclick = null;
    cancelButton.onclick = null;
    payButton.disabled = true;
    cancelButton.disabled = true;
    quoteButton.disabled = false;
    connectButton.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  if (pending?.status === "pending") pending.cancel("Page closed");
  client?.close();
});

function showQuotes(request: ManualPaymentRequest): void {
  quotePanel.classList.remove("hidden");
  price.value =
    request.merkle
      ? `Up to ${request.totalAmountAtto} atto-tokens for this Merkle payment`
      : `${request.totalAmountAtto} atto-tokens across ${request.quotes.length} quotes`;
  quoteList.replaceChildren(
    ...request.quotes.map((quote) => {
      const item = document.createElement("li");
      const chunkAddress = quoteChunkAddress(quote);
      item.textContent = `${chunkAddress.slice(0, 12)}: ${quote.amount} atto`;
      item.title = chunkAddress;
      return item;
    }),
  );
  paymentState.value = "Review the quotes or switch wallet before paying.";
  payButton.disabled = false;
  cancelButton.disabled = false;
}

function payPendingRequest(request: ManualPaymentRequest): void {
  let selectedPayment: PaymentProvider;
  try {
    selectedPayment = selectedWalletPayment();
  } catch (error) {
    paymentState.value = `Select a wallet: ${errorMessage(error)}`;
    return;
  }
  payButton.disabled = true;
  cancelButton.disabled = true;
  paymentState.value = "Confirm payment in the selected wallet…";
  void request.pay(selectedPayment).then(
    () => {
      paymentState.value = "Payment confirmed; uploading records…";
    },
    (error: unknown) => {
      paymentState.value = `Payment failed: ${errorMessage(error)}`;
    },
  );
}

function selectedWalletPayment(): PaymentProvider {
  if (walletMode.value === "injected") return connectedEthersPaymentProvider();
  const key = privateKey.value.trim();
  if (!key) throw new Error("Enter a disposable private key");
  return createEthersPaymentProvider({ privateKey: key, rpcUrl: paymentRpc.value.trim(), approval: "exact" });
}

function refreshWalletControls(): void {
  const useInjected = walletMode.value === "injected";
  injectedFields.classList.toggle("hidden", !useInjected);
  privateKeyFields.classList.toggle("hidden", useInjected);
}

function quoteChunkAddress(
  quote: ManualPaymentRequest["quotes"][number],
): string {
  const artifact = quote.quote;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("content" in artifact) ||
    typeof artifact.content !== "string"
  ) {
    throw new Error("Verified storage quote is missing its chunk address");
  }
  return artifact.content;
}
