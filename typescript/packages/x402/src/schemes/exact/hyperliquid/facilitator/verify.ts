import {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  ExactHlPayload,
} from "../../../../types/verify";
import { SupportedHLNetworks } from "../../../../types/shared";
import { SCHEME } from "../../";
import { X402Config } from "../../../../types/config";

export async function verify(
  _client: unknown,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  _config?: X402Config,
): Promise<VerifyResponse> {
  if (
    paymentPayload.scheme !== SCHEME ||
    paymentRequirements.scheme !== SCHEME ||
    paymentPayload.network !== paymentRequirements.network ||
    !SupportedHLNetworks.includes(paymentRequirements.network)
  ) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_network",
    };
  }

  const payload = paymentPayload.payload as ExactHlPayload;
  const rawAction = payload.action;
  if (!rawAction || typeof rawAction !== "object") {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_payload",
    };
  }
  const action = rawAction as Record<string, unknown>;

  const destination = typeof action.destination === "string" ? (action.destination as string) : undefined;
  const token = typeof action.token === "string" ? (action.token as string) : undefined;
  const amount = typeof action.amount === "string" ? (action.amount as string) : undefined;

  if (!destination || !token || !amount) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_payload",
    };
  }

  if (destination.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_payload_recipient_mismatch",
    };
  }

  if (token !== paymentRequirements.asset) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_payload_asset_mismatch",
    };
  }

  const hasValidAmount = ensureAmountMeetsRequirement(
    amount,
    paymentRequirements.maxAmountRequired,
    paymentRequirements.extra?.decimals as number | undefined,
  );
  if (!hasValidAmount) {
    return {
      isValid: false,
      invalidReason: "invalid_exact_hl_payload_amount_mismatch",
    };
  }

  if (!withinTtl(action.time, paymentRequirements.maxTimeoutSeconds)) {
    return {
      isValid: false,
      invalidReason: "payment_expired",
    };
  }

  return {
    isValid: true,
    payer: typeof action.user === "string" ? (action.user as string) : undefined,
  };
}

function ensureAmountMeetsRequirement(
  payloadAmount: string,
  requiredAtomicAmount: string,
  decimals?: number,
): boolean {
  if (decimals == null || decimals < 0) {
    return Number(payloadAmount) >= Number(requiredAtomicAmount);
  }

  try {
    const payloadAtomic = decimalToAtomic(payloadAmount, decimals);
    return payloadAtomic >= BigInt(requiredAtomicAmount);
  } catch {
    return false;
  }
}

function decimalToAtomic(value: string, decimals: number): bigint {
  const sanitized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(sanitized)) {
    throw new Error("invalid decimal");
  }
  const [whole, fraction = ""] = sanitized.split(".");
  const normalizedFraction =
    fraction.length > decimals
      ? fraction.slice(0, decimals)
      : fraction.padEnd(decimals, "0");
  const wholeUnits = BigInt(whole || "0") * 10n ** BigInt(decimals);
  const fractionalUnits = BigInt(normalizedFraction || "0");
  return wholeUnits + fractionalUnits;
}

function withinTtl(actionTime: unknown, maxTimeoutSeconds: number): boolean {
  if (typeof actionTime !== "number" || !Number.isFinite(actionTime)) {
    return false;
  }
  const expiresAt = actionTime + maxTimeoutSeconds * 1000;
  return Date.now() <= expiresAt;
}
