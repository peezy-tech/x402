import { signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { ApproveAgentRequest, ApproveAgentTypes, parser } from "@nktkas/hyperliquid/api/exchange";
import { privateKeyToAccount } from "viem/accounts";

const wallet = privateKeyToAccount("0x..."); // viem or ethers

const action = parser(ApproveAgentRequest.entries.action)({ // for correct signature generation
  type: "approveAgent",
  signatureChainId: "0x66eee",
  hyperliquidChain: "Mainnet",
  agentAddress: "0x...",
  agentName: "Agent",
  nonce: Date.now(),
});

const signature = await signUserSignedAction({ wallet, action, types: ApproveAgentTypes });

// Send the signed action to the Hyperliquid API - we would do this on the `settle` action on the facilitator.
const response = await fetch("https://api.hyperliquid.xyz/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, signature, nonce: action.nonce }),
});
const body = await response.json();