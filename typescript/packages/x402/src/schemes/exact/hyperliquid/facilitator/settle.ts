import {
  ExactHlPayload,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "../../../../types/verify";
import { SupportedHLNetworks } from "../../../../types/shared";
import { getExchangeBaseUrl, createInfoClient, fetchTransactionDetails } from "../../../../shared/hyperliquid";
import { SCHEME } from "../../";
import { X402Config } from "../../../../types/config";

const CONFIRMATION_RETRIES = 3;
const CONFIRMATION_DELAY_MS = 250;

export async function settle(
  _client: unknown,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  _config?: X402Config,
): Promise<SettleResponse> {
  if (
    paymentPayload.scheme !== SCHEME ||
    paymentRequirements.scheme !== SCHEME ||
    paymentPayload.network !== paymentRequirements.network ||
    !SupportedHLNetworks.includes(paymentRequirements.network)
  ) {
    return failureResponse("invalid_exact_hl_network", paymentRequirements, paymentPayload);
  }

  const payload = paymentPayload.payload as ExactHlPayload;
  const endpoint = getExchangeBaseUrl(paymentRequirements.network);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: payload.action,
        signature: payload.signature,
        nonce: payload.nonce,
      }),
    });

    if (!response.ok) {
      return failureResponse("hl_exchange_error", paymentRequirements, paymentPayload);
    }

    const body = await response.json().catch(() => null);
    if (body?.status !== "ok") {
      return failureResponse("hl_exchange_error", paymentRequirements, paymentPayload);
    }

    const txHash =
      (body?.response?.txHash as string | undefined) ??
      (body?.txHash as string | undefined) ??
      (body?.hash as string | undefined);

    if (txHash && isHexHash(txHash)) {
      const confirmationResult = await confirmTransaction(paymentRequirements.network, txHash as `0x${string}`);
      if (confirmationResult === "not_found") {
        return failureResponse("hl_tx_not_found", paymentRequirements, paymentPayload, txHash);
      }
      if (confirmationResult === "timeout") {
        return failureResponse("hl_tx_unconfirmed", paymentRequirements, paymentPayload, txHash);
      }
    }

    return {
      success: true,
      transaction: txHash ?? extractFallbackTransaction(paymentRequirements),
      network: paymentRequirements.network,
      payer: extractPayer(payload),
    };
  } catch (error) {
    console.error("Hyperliquid settle error", error);
    return failureResponse("hl_exchange_error", paymentRequirements, paymentPayload);
  }
}

type ConfirmationResult = "confirmed" | "not_found" | "timeout";

async function confirmTransaction(network: PaymentRequirements["network"], hash: `0x${string}`): Promise<ConfirmationResult> {
  const client = createInfoClient(network);

  for (let attempt = 0; attempt < CONFIRMATION_RETRIES; attempt++) {
    try {
      await fetchTransactionDetails(client, hash);
      return "confirmed";
    } catch (error) {
      if (String(error?.toString()).toLowerCase().includes("not found")) {
        return "not_found";
      }
    }
    await delay(CONFIRMATION_DELAY_MS);
  }

  return "timeout";
}

function failureResponse(
  reason: SettleResponse["errorReason"],
  paymentRequirements: PaymentRequirements,
  payload: PaymentPayload,
  txHash?: string,
): SettleResponse {
  const transaction = txHash ?? extractFallbackTransaction(paymentRequirements);
  return {
    success: false,
    errorReason: reason,
    transaction,
    network: paymentRequirements.network,
    payer: extractPayer(payload.payload),
  };
}

function extractFallbackTransaction(paymentRequirements: PaymentRequirements): string {
  return paymentRequirements.payTo;
}

function extractPayer(payload: PaymentPayload["payload"]): string | undefined {
  if (!payload || typeof payload !== "object" || !("action" in payload)) {
    return undefined;
  }
  const action = (payload as ExactHlPayload).action as Record<string, unknown>;
  return typeof action.user === "string" ? (action.user as string) : undefined;
}

function isHexHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
