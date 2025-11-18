import { OnchainKitProvider } from "@coinbase/onchainkit";
import type { ReactNode } from "react";
import { base, baseSepolia } from "viem/chains";

import { createConfig, http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const queryClient = new QueryClient();

import { choosePaymentRequirement, isEvmNetwork, isHyperliquidNetwork } from "./paywallUtils";
import "./window.d.ts";

type ProvidersProps = {
  children: ReactNode;
};

/**
 * Providers component for the paywall
 *
 * @param props - The component props
 * @param props.children - The children of the Providers component
 * @returns The Providers component
 */
export function Providers({ children }: ProvidersProps) {
  const { testnet = true, cdpClientKey, appName, appLogo, paymentRequirements } = window.x402;
  const selectedRequirement = choosePaymentRequirement(paymentRequirements, testnet);

  if (
    !isEvmNetwork(selectedRequirement.network) &&
    !isHyperliquidNetwork(selectedRequirement.network)
  ) {
    return <>{children}</>;
  }

  if (isEvmNetwork(selectedRequirement.network)) {
    const chain = selectedRequirement.network === "base-sepolia" ? baseSepolia : base;

    return (
      <OnchainKitProvider
        apiKey={cdpClientKey || undefined}
        chain={chain}
        config={{
          appearance: {
            mode: "light",
            theme: "base",
            name: appName || undefined,
            logo: appLogo || undefined,
          },
          wallet: {
            display: "modal",
            supportedWallets: {
              rabby: true,
              trust: true,
              frame: true,
            },
          },
        }}
      >
        {children}
      </OnchainKitProvider>
    );
  }

  const chain = arbitrum;

  const config = createConfig({
    chains: [arbitrum],
    transports: {
      [arbitrum.id]: http(),
    },
  });

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
