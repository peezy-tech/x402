import * as hl from "@nktkas/hyperliquid";
import {
  Network,
  HlNetworkToChainName,
  SupportedHLNetworks,
  HyperliquidChainName,
} from "../../types/shared";
import type { TokenDetailsResponse, TxDetailsResponse } from "@nktkas/hyperliquid/api/info";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { toHex } from "viem";

type HyperliquidNetworkConfig = {
  token: string;
  decimals: number;
  signatureChainId: `0x${string}`;
};

const HyperliquidNetworkConfigs = new Map<Network, HyperliquidNetworkConfig>([
  [
    "hyperliquid-testnet",
    {
      token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
      decimals: 6,
      signatureChainId: toHex(arbitrum.id),
    },
  ],
  [
    "hyperliquid",
    {
      token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
      decimals: 6,
      signatureChainId: toHex(arbitrum.id),
    },
  ],
]);

function assertHyperliquidNetwork(
  network: Network,
): asserts network is (typeof SupportedHLNetworks)[number] {
  if (!SupportedHLNetworks.includes(network)) {
    throw new Error(`Unsupported Hyperliquid network: ${network}`);
  }
}

function getHyperliquidNetworkConfig(network: Network): HyperliquidNetworkConfig {
  assertHyperliquidNetwork(network);
  const config = HyperliquidNetworkConfigs.get(network);
  if (!config) {
    throw new Error(`Missing Hyperliquid config for ${network}`);
  }
  return config;
}

export function getDefaultHyperliquidAsset(network: Network) {
  const config = getHyperliquidNetworkConfig(network);
  return {
    address: config.token,
    decimals: config.decimals,
  };
}

export function getHyperliquidSignatureChainId(network: Network): `0x${string}` {
  return getHyperliquidNetworkConfig(network).signatureChainId;
}

export function getHyperliquidChain(network: Network): HyperliquidChainName {
  assertHyperliquidNetwork(network);
  const chain = HlNetworkToChainName.get(network);
  if (!chain) {
    throw new Error(`Missing Hyperliquid chain mapping for ${network}`);
  }
  return chain;
}

export function createInfoClient(
  network: Network,
  options?: ConstructorParameters<typeof hl.HttpTransport>[0],
): hl.InfoClient {
  assertHyperliquidNetwork(network);
  const transport = new hl.HttpTransport({
    ...options,
    isTestnet: network === "hyperliquid-testnet",
  });
  return new hl.InfoClient({ transport });
}

export function getExchangeBaseUrl(network: Network): string {
  assertHyperliquidNetwork(network);
  return network === "hyperliquid-testnet"
    ? "https://api.hyperliquid-testnet.xyz/exchange"
    : "https://api.hyperliquid.xyz/exchange";
}

export async function fetchTransactionDetails(
  client: hl.InfoClient,
  hash: TxDetailsResponse["tx"]["hash"],
): Promise<TxDetailsResponse["tx"]> {
  const response = await client.txDetails({ hash });
  return response.tx;
}

type HyperliquidTokenInfo = {
  decimals: number;
  symbol?: string;
  name?: string;
  tokenId?: string;
};

const hyperliquidTokenInfoCache = new Map<string, HyperliquidTokenInfo>();

export async function fetchHyperliquidTokenInfo(
  network: Network,
  tokenId: string,
): Promise<HyperliquidTokenInfo> {
  assertHyperliquidNetwork(network);
  const cacheKey = `${network}:${tokenId.toLowerCase()}`;
  const cached = hyperliquidTokenInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = createInfoClient(network);
  const response: TokenDetailsResponse = await client.tokenDetails({ tokenId });
  const info: HyperliquidTokenInfo = {
    decimals: response.weiDecimals,
    symbol: response.name,
    name: response.name,
    tokenId,
  };
  hyperliquidTokenInfoCache.set(cacheKey, info);
  return info;
}
