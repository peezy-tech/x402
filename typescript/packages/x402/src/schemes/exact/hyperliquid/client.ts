import { encodePayment } from "../../utils";
import { PaymentPayload, PaymentRequirements } from "../../../types/verify";
import { fetchHyperliquidTokenInfo, getHyperliquidChain } from "../../../shared/hyperliquid";
import { parser, SpotSendRequest, SpotSendTypes } from "@nktkas/hyperliquid/api/exchange";
import { signUserSignedAction } from "@nktkas/hyperliquid/signing";
import type { WalletClient } from "viem";
import type { LocalAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { toHex } from "viem";

type WalletWithAddress = {
  address?: string;
  account?: { address?: string };
};

type HyperliquidWallet = (
  | Parameters<typeof signUserSignedAction>[0]["wallet"]
  | LocalAccount
  | WalletClient
) &
  WalletWithAddress;

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
  const signerAddress = getWalletAddress(wallet);
  const decimals = await resolveHyperliquidDecimals(paymentRequirements);
  const nonce = Date.now();
  const request = parser(SpotSendRequest)({
    action: {
      type: "spotSend",
      signatureChainId: toHex(arbitrum.id), // (paymentRequirements.extra?.signatureChainId as `0x${string}`) ?? "0x66eee",
      hyperliquidChain: getHyperliquidChain(paymentRequirements.network),
      destination: paymentRequirements.payTo,
      token: await resolveTokenString(paymentRequirements),
      amount: formatDecimalAmount(
        paymentRequirements.maxAmountRequired,
        decimals,
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
      user: signerAddress,
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

function getWalletAddress(wallet: HyperliquidWallet): string {
  const address = wallet.address ?? wallet.account?.address;
  if (typeof address !== "string" || !address.toLowerCase().startsWith("0x")) {
    throw new Error("Hyperliquid wallet missing address");
  }
  return address;
}

async function resolveHyperliquidDecimals(paymentRequirements: PaymentRequirements): Promise<number | undefined> {
  const existing = paymentRequirements.extra?.decimals;
  if (typeof existing === "number") {
    return existing;
  }

  const tokenId = paymentRequirements.asset?.startsWith("0x")
    ? paymentRequirements.asset
    : undefined;

  if (!tokenId) {
    return undefined;
  }

  try {
    const tokenInfo = await fetchHyperliquidTokenInfo(paymentRequirements.network, tokenId);
    return tokenInfo.decimals;
  } catch (error) {
    console.warn("[hyperliquid] failed to fetch token decimals for payload creation", error);
    return undefined;
  }
}

async function resolveTokenString(paymentRequirements: PaymentRequirements): Promise<string> {
  const current = paymentRequirements.asset;
  if (current.includes(":")) {
    return current;
  }

  const tokenId = current;
  const symbol =
    typeof paymentRequirements.extra?.tokenSymbol === "string"
      ? paymentRequirements.extra.tokenSymbol
      : undefined;

  if (symbol) {
    return `${symbol}:${tokenId}`;
  }

  try {
    const info = await fetchHyperliquidTokenInfo(paymentRequirements.network, tokenId);
    if (info.symbol) {
      return `${info.symbol}:${tokenId}`;
    }
  } catch (error) {
    console.warn("[hyperliquid] client: failed to fetch token symbol for token string", error);
  }

  return `TOKEN:${tokenId}`;
}
