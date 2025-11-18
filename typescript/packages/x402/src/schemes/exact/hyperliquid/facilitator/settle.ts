import type { InfoClient } from "@nktkas/hyperliquid";
import { ExactHlPayload, PaymentPayload, PaymentRequirements, SettleResponse } from "../../../../types/verify";
import { SupportedHLNetworks } from "../../../../types/shared";
import { getExchangeBaseUrl, createInfoClient, fetchTransactionDetails } from "../../../../shared/hyperliquid";
import { SCHEME } from "../../";
import { X402Config } from "../../../../types/config";

const CONFIRMATION_RETRIES = 3;
const CONFIRMATION_DELAY_MS = 250;

type HyperliquidSettleResponse = {
  status?: string;
  response?: {
    txHash?: string;
  };
  txHash?: string;
  hash?: string;
};

type HyperliquidUserTransaction = {
  hash?: string;
  time?: number;
  action?: Record<string, unknown>;
} & Record<string, unknown>;

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
  if (!payload?.action || typeof payload.action !== "object") {
    return failureResponse("invalid_exact_hl_payload", paymentRequirements, paymentPayload);
  }

  const payer = extractPayer(payload);
  const endpoint = getExchangeBaseUrl(paymentRequirements.network);
  const infoClient = createInfoClient(paymentRequirements.network);

  try {
    const exchangeResponse = await submitExchange(endpoint, payload);
    const exchangeTxHash = extractExchangeTxHash(exchangeResponse);

    const matchedHash = payer
      ? await findMatchingTransactionHash(infoClient, payer, payload, paymentRequirements)
      : undefined;

    if (payer && !matchedHash) {
      console.warn("[hyperliquid] settle: no matching tx hash found in userDetails response");
      return failureResponse("hl_tx_not_found", paymentRequirements, paymentPayload, exchangeTxHash, payer);
    }

    const txHash = matchedHash ?? exchangeTxHash;

    if (!txHash || !isHexHash(txHash)) {
      console.warn("[hyperliquid] settle: missing transaction hash after exchange + userDetails lookup");
      return failureResponse("hl_tx_not_found", paymentRequirements, paymentPayload, exchangeTxHash, payer);
    }

    const confirmationResult = await confirmTransaction(infoClient, txHash as `0x${string}`);
    if (confirmationResult === "not_found") {
      return failureResponse("hl_tx_not_found", paymentRequirements, paymentPayload, txHash, payer);
    }
    if (confirmationResult === "timeout") {
      return failureResponse("hl_tx_unconfirmed", paymentRequirements, paymentPayload, txHash, payer);
    }

    return {
      success: true,
      transaction: txHash,
      network: paymentRequirements.network,
      payer,
    };
  } catch (error) {
    console.error("Hyperliquid settle error", error);
    return failureResponse("hl_exchange_error", paymentRequirements, paymentPayload);
  }
}

type ConfirmationResult = "confirmed" | "not_found" | "timeout";

async function confirmTransaction(infoClient: InfoClient, hash: `0x${string}`): Promise<ConfirmationResult> {
  for (let attempt = 0; attempt < CONFIRMATION_RETRIES; attempt++) {
    try {
      await fetchTransactionDetails(infoClient, hash);
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

async function submitExchange(endpoint: string, payload: ExactHlPayload): Promise<HyperliquidSettleResponse> {
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
    throw new Error("hyperliquid_exchange_failed");
  }

  const body = (await response.json().catch(() => null)) as HyperliquidSettleResponse | null;
  if (!body || body?.status !== "ok") {
    throw new Error("hyperliquid_exchange_failed");
  }

  return body;
}

function extractExchangeTxHash(response: HyperliquidSettleResponse | null): string | undefined {
  if (!response) {
    return undefined;
  }

  return response.response?.txHash ?? response.txHash ?? response.hash;
}

async function findMatchingTransactionHash(
  infoClient: InfoClient,
  payer: string,
  payload: ExactHlPayload,
  paymentRequirements: PaymentRequirements,
): Promise<`0x${string}` | undefined> {
  try {
    const userDetails = await infoClient.userDetails({ user: payer });
    const userTxs = extractUserTransactions(userDetails);

    const matches = userTxs
      .filter(tx => transactionMatchesPayment(tx, payload, paymentRequirements))
      .sort((a, b) => getTxTimestamp(b) - getTxTimestamp(a));

    const matchingHash = matches
      .map(tx => tx.hash)
      .find(hash => typeof hash === "string" && isHexHash(hash)) as `0x${string}` | undefined;

    return matchingHash;
  } catch (error) {
    console.error("[hyperliquid] settle: failed to fetch userDetails", error);
    return undefined;
  }
}

function transactionMatchesPayment(
  tx: HyperliquidUserTransaction,
  payload: ExactHlPayload,
  paymentRequirements: PaymentRequirements,
): boolean {
  // Matching logic mirrors the manual flow exercised in packages/x402/references/user-signed-action.ts
  const action = getTxAction(tx);
  const payloadAction = payload.action as Record<string, unknown>;

  const destinationMatches = equalsIgnoreCase(action?.destination, paymentRequirements.payTo);
  const tokenMatches = equalsIgnoreCase(action?.token, paymentRequirements.asset);

  const payloadAmount = coerceAmountToNumber(payloadAction?.amount);
  const txAmount = coerceAmountToNumber(action?.amount);
  const amountMatches = payloadAmount != null && txAmount != null && txAmount === payloadAmount;

  const signatureChainMatches = valuesMatch(action?.signatureChainId, payloadAction?.signatureChainId);
  const hyperliquidChainMatches = valuesMatch(action?.hyperliquidChain, payloadAction?.hyperliquidChain);
  const typeMatches = valuesMatch(action?.type, payloadAction?.type);

  const txTime = toNumber(action?.time) ?? toNumber(tx.time);
  const payloadTime = toNumber(payloadAction?.time);
  const nonce = typeof payload.nonce === "number" ? payload.nonce : undefined;
  const timeOrNonceMatches =
    payloadTime == null && nonce == null ? true : txTime != null && (txTime === payloadTime || txTime === nonce);

  return (
    destinationMatches &&
    tokenMatches &&
    amountMatches &&
    signatureChainMatches &&
    hyperliquidChainMatches &&
    typeMatches &&
    timeOrNonceMatches
  );
}

function extractUserTransactions(details: unknown): HyperliquidUserTransaction[] {
  const txCollections = [
    (details as any)?.txs,
    (details as any)?.userFlow,
    (details as any)?.actions,
    (details as any)?.transactions,
  ];

  const fromPreferredField = txCollections.find(Array.isArray);
  if (Array.isArray(fromPreferredField)) {
    return fromPreferredField as HyperliquidUserTransaction[];
  }

  return [];
}

function getTxAction(tx: HyperliquidUserTransaction): Record<string, unknown> | undefined {
  const candidate = (tx as any)?.action ?? tx;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined;
}

function coerceAmountToNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function valuesMatch(candidate: unknown, expected: unknown): boolean {
  if (expected == null) {
    return true;
  }

  return equalsIgnoreCase(candidate, expected);
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function equalsIgnoreCase(a: unknown, b: unknown): boolean {
  const left = toLower(a);
  const right = toLower(b);
  return left != null && right != null && left === right;
}

function toLower(value: unknown): string | undefined {
  const normalized = stringify(value);
  return normalized?.toLowerCase();
}

function getTxTimestamp(tx: HyperliquidUserTransaction): number {
  const actionTime = toNumber((tx as any)?.action?.time);
  if (actionTime != null) {
    return actionTime;
  }
  return toNumber(tx.time) ?? 0;
}

function failureResponse(
  reason: SettleResponse["errorReason"],
  paymentRequirements: PaymentRequirements,
  payload: PaymentPayload,
  txHash?: string,
  payer?: string,
): SettleResponse {
  const transaction = txHash ?? extractFallbackTransaction(paymentRequirements);
  return {
    success: false,
    errorReason: reason,
    transaction,
    network: paymentRequirements.network,
    payer: payer ?? extractPayer(payload.payload),
  };
}

function extractFallbackTransaction(paymentRequirements: PaymentRequirements): string {
  return paymentRequirements.payTo;
}

function extractPayer(payload: PaymentPayload["payload"]): string | undefined {
  if (!payload || typeof payload !== "object" || !("action" in payload)) {
    return undefined;
  }
  const exactPayload = payload as ExactHlPayload;

  if (typeof exactPayload.user === "string") {
    return exactPayload.user;
  }

  const action = exactPayload.action as Record<string, unknown>;
  return typeof action.user === "string" ? (action.user as string) : undefined;
}

function isHexHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
