import { encodePayment } from "../../utils";
import { PaymentPayload, PaymentRequirements } from "../../../types/verify";
import { getHyperliquidChain } from "../../../shared/hyperliquid";
import { parser, SpotSendRequest, SpotSendTypes } from "@nktkas/hyperliquid/api/exchange";
import { signUserSignedAction } from "@nktkas/hyperliquid/signing";
import type { LocalAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { toHex } from "viem";

type HyperliquidWallet = Parameters<typeof signUserSignedAction>[0]["wallet"] | LocalAccount;

export async function createPaymentHeader(
  wallet: HyperliquidWallet,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<string> {
  const paymentPayload = await createPaymentPayload(wallet, x402Version, paymentRequirements);
  return encodePayment(paymentPayload);
}

export async function createPaymentPayload(
  wallet: HyperliquidWallet,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<PaymentPayload> {
  const nonce = Date.now();
  const request = parser(SpotSendRequest)({
    action: {
      type: "spotSend",
      signatureChainId: toHex(arbitrum.id), // (paymentRequirements.extra?.signatureChainId as `0x${string}`) ?? "0x66eee",
      hyperliquidChain: getHyperliquidChain(paymentRequirements.network),
      destination: paymentRequirements.payTo,
      token: paymentRequirements.asset,
      amount: formatDecimalAmount(
        paymentRequirements.maxAmountRequired,
        paymentRequirements.extra?.decimals as number | undefined,
      ),
      time: nonce,
    },
    nonce,
    signature: {
      r: "0x0000000000000000000000000000000000000000000000000000000000000000",
      s: "0x0000000000000000000000000000000000000000000000000000000000000000",
      v: 27,
    },
  });

  const signature = await signUserSignedAction({
    wallet: wallet as Parameters<typeof signUserSignedAction>[0]["wallet"],
    action: request.action,
    types: SpotSendTypes,
  });

  return {
    x402Version,
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    payload: {
      action: request.action,
      signature,
      nonce,
    },
  };
}

function formatDecimalAmount(amount: string, decimals?: number): string {
  if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals <= 0) {
    return amount;
  }

  const normalizedDecimals = Math.trunc(decimals);
  const bigAmount = BigInt(amount);
  const divisor = 10n ** BigInt(normalizedDecimals);
  const whole = bigAmount / divisor;
  const remainder = bigAmount % divisor;

  if (remainder === 0n) {
    return whole.toString();
  }

  const remainderStr = remainder
    .toString()
    .padStart(normalizedDecimals, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${remainderStr}`;
}
