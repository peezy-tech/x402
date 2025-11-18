import { Avatar, Name } from "@coinbase/onchainkit/identity";
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
} from "@coinbase/onchainkit/wallet";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import { useCallback, useEffect, useMemo, useState } from "react";
import { arbitrum, arbitrumSepolia } from "viem/chains";

import type { PaymentRequirements } from "../../types/verify";
import type { Network } from "../../types/shared";
import { exact } from "../../schemes";

import { Spinner } from "./Spinner";
import { ensureValidAmount } from "./utils";
import { getNetworkDisplayName, isTestnetNetwork } from "./paywallUtils";

type HyperliquidPaywallProps = {
  paymentRequirement: PaymentRequirements;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

export function HyperliquidPaywall({
  paymentRequirement,
  onSuccessfulResponse,
}: HyperliquidPaywallProps) {
  const x402 = window.x402;
  const { address, isConnected, connector, chainId: connectedChainId } = useAccount();
  const paymentChain = arbitrum;
  const chainId = paymentChain.id;
  const { data: wagmiWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const [status, setStatus] = useState<string>("");
  const [isPaying, setIsPaying] = useState(false);
  const [isCorrectChain, setIsCorrectChain] = useState<boolean | null>(null);

  console.log("[HyperliquidPaywall] init", {
    paymentRequirement,
    x402,
    address,
    isConnected,
    hasWalletClient: Boolean(wagmiWalletClient),
  });

  const decimals =
    typeof paymentRequirement.extra?.decimals === "number" ? paymentRequirement.extra.decimals : 6;
  const tokenSymbol =
    typeof paymentRequirement.extra?.tokenSymbol === "string"
      ? paymentRequirement.extra.tokenSymbol
      : "USDC";

  const amount = useMemo(() => {
    if (typeof x402.amount === "number") {
      return x402.amount;
    }

    const atomicAmount = Number(paymentRequirement.maxAmountRequired ?? "0");
    return atomicAmount / 10 ** decimals;
  }, [x402.amount, paymentRequirement.maxAmountRequired, decimals]);

  const chainName = getNetworkDisplayName(paymentRequirement.network as Network);
  const testnet = isTestnetNetwork(paymentRequirement.network as Network);

  const requestWithPayment = useCallback(
    async (paymentHeader: string) => {
      console.log("[HyperliquidPaywall] requesting protected resource", {
        url: x402.currentUrl,
        paymentHeader,
      });
      return await fetch(x402.currentUrl, {
        headers: {
          "X-PAYMENT": paymentHeader,
          "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
        },
      });
    },
    [x402.currentUrl],
  );

  const handleSwitchChain = useCallback(async () => {
    if (isCorrectChain) {
      return;
    }

    try {
      setStatus("");
      await switchChainAsync({ chainId });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.log({ chainId, connectedChainId });
      console.error("[HyperliquidPaywall] failed to switch chain", error);
      setStatus(error instanceof Error ? error.message : "Failed to switch network");
    }
  }, [switchChainAsync, chainId, isCorrectChain]);

  useEffect(() => {
    if (!address) {
      return;
    }

    void handleSwitchChain();
  }, [address, handleSwitchChain]);

  useEffect(() => {
    if (isConnected && chainId === connectedChainId) {
      setIsCorrectChain(true);
      setStatus("");
    } else if (isConnected && chainId !== connectedChainId) {
      setIsCorrectChain(false);
      setStatus(`On the wrong network. Please switch to ${paymentChain.name}.`);
    } else {
      setIsCorrectChain(null);
      setStatus("");
    }
  }, [chainId, connectedChainId, isConnected, paymentChain.name]);

  const handlePayment = useCallback(async () => {
    if (!x402) {
      console.log("[HyperliquidPaywall] missing window.x402 context");
      return;
    }

    if (!address) {
      console.log("[HyperliquidPaywall] wallet not ready: missing address");
      setStatus("Connect a wallet that can sign Hyperliquid transactions to continue.");
      return;
    }

    await handleSwitchChain();

    let walletClient = wagmiWalletClient;
    if (!walletClient && connector) {
      console.log("[HyperliquidPaywall] attempting connector.getWalletClient");
      const getWalletClient = (connector as { getWalletClient?: unknown }).getWalletClient;
      if (typeof getWalletClient === "function") {
        try {
          const resolvedClient = await getWalletClient();
          if (resolvedClient) {
            walletClient = resolvedClient as typeof wagmiWalletClient;
          }
        } catch (connError) {
          console.error("[HyperliquidPaywall] connector getWalletClient failed", connError);
        }
      }
    }

    if (!walletClient) {
      console.log("[HyperliquidPaywall] wallet not ready", {
        address,
        hasWalletClient: Boolean(wagmiWalletClient),
        hasConnector: Boolean(connector),
      });
      setStatus("Connect a wallet that can sign Hyperliquid transactions to continue.");
      return;
    }
    const validRequirement = ensureValidAmount(paymentRequirement);
    console.log("[HyperliquidPaywall] validated requirement", validRequirement);

    setIsPaying(true);
    setStatus("Creating payment signature...");

    try {
      console.log("[HyperliquidPaywall] creating payment header");
      let paymentHeader = await exact.hyperliquid.createPaymentHeader(
        walletClient,
        1,
        validRequirement,
      );
      console.log("[HyperliquidPaywall] payment header created");

      let response = await requestWithPayment(paymentHeader);
      console.log("[HyperliquidPaywall] initial response", response.status);

      if (!response.ok && response.status === 402) {
        const errorData = await response.json().catch(() => ({}));
        console.log("[HyperliquidPaywall] server returned 402", errorData);
        if (typeof errorData?.x402Version === "number") {
          setStatus("Retrying payment with updated version...");
          paymentHeader = await exact.hyperliquid.createPaymentHeader(
            walletClient,
            errorData.x402Version,
            validRequirement,
          );
          console.log("[HyperliquidPaywall] retry header created");
          response = await requestWithPayment(paymentHeader);
          console.log("[HyperliquidPaywall] retry response", response.status);
        }
      }

      if (response.ok) {
        console.log("[HyperliquidPaywall] payment accepted");
        await onSuccessfulResponse(response);
        setStatus("Payment complete.");
        return;
      }

      throw new Error(`Payment failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.error("[HyperliquidPaywall] payment error", error);
      setStatus(error instanceof Error ? error.message : "Payment failed");
    } finally {
      console.log("[HyperliquidPaywall] payment flow finished");
      setIsPaying(false);
    }
  }, [
    x402,
    address,
    wagmiWalletClient,
    connector,
    chainId,
    handleSwitchChain,
    paymentRequirement,
    onSuccessfulResponse,
    requestWithPayment,
  ]);

  if (!x402) {
    return null;
  }

  return (
    <div className="container gap-8">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p>
          {paymentRequirement.description && `${paymentRequirement.description}.`} To access this
          content, please pay {amount} {tokenSymbol} on Hyperliquid.
        </p>
        {testnet && (
          <p className="instructions">
            Need Hyperliquid testnet funds? Visit the Hyperliquid docs to request faucet access.
          </p>
        )}
      </div>

      <div className="content w-full">
        <Wallet className="w-full">
          <ConnectWallet className="w-full py-3" disconnectedLabel="Connect wallet">
            <Avatar className="h-5 w-5 opacity-80" />
            <Name className="text-sm font-medium">
              {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Connect wallet"}
            </Name>
          </ConnectWallet>

          <WalletDropdown>
            <WalletDropdownDisconnect />
          </WalletDropdown>
        </Wallet>

        <button
          className="button primary"
          disabled={!isConnected || !wagmiWalletClient || isPaying}
          onClick={() => {
            void handlePayment();
          }}
        >
          {isPaying ? <Spinner /> : `Pay ${amount} ${tokenSymbol} on ${chainName}`}
        </button>

        {status && <p className="status text-sm text-gray-500">{status}</p>}
      </div>
    </div>
  );
}
