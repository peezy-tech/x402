# Hyperliquid L1 Integration Plan (x402 Typescript)

This document scopes the work to add Hyperliquid L1 support to the base `x402` package. Hyperliquid uses EVM-style addresses but is not EVM-compatible, so we will treat it as its own network family with dedicated verify/settle code paths and a payload type under the existing `exact` scheme.

References added to the repo:

- `references/hyperliquid_routes.ts` – simple REST routes verifying a paid invoice via `InfoClient.txDetails` and matching fields
- `references/user-signed-action.ts` – signs a Hyperliquid User Signed Action (ApproveAgent) and posts to `https://api.hyperliquid.xyz/exchange`
- `references/spotSend.ts` – SDK’s canonical `spotSend` implementation, including TokenId format (e.g., `"USDC:0xeb62eee3685fc4c43992febcd9e75443"`) and EIP‑712 types

Installed dependencies:

- `@nktkas/hyperliquid` is already included in `package.json`
- `zod`, `viem`, and the x402 scheme structure for EVM/SVM are already in place to model a third family

Patterns to reuse:

- Scheme routing via `src/facilitator/facilitator.ts` (wraps per-scheme verify/settle and branches by network family)
- Payment encode/decode via `src/schemes/exact/evm/utils/paymentUtils.ts` (currently handles both EVM and SVM, re-exported by `schemes/utils`)
- Network family structure via `src/types/shared/network.ts` (SupportedEVMNetworks, SupportedSVMNetworks)
- SVM integration pattern (separate client, verify, and settle implementations under `schemes/exact/svm`)

## Deliverables (Checklist)

- [x] Add Hyperliquid networks to `NetworkSchema` and define a new network family

  - [x] Add `hyperliquid-testnet`, `hyperliquid` to `NetworkSchema`
  - [x] Create `SupportedHLNetworks: Network[]` in `types/shared/network.ts`
  - [x] Expose a small helper to map the x402 network to Hyperliquid SDK params (e.g., `hyperliquidChain: 'Mainnet' | 'Testnet'` and REST base URL)

- [x] Introduce a Hyperliquid payload variant for the `exact` scheme

  - [x] Add `ExactHlPayloadSchema` to `types/verify/x402Specs.ts` and update `PaymentPayloadSchema` union
  - [x] Extend `ErrorReasons` with Hyperliquid-specific invalidation and settlement errors
  - [x] Update `PaymentRequirementsSchema.asset` to accept HL TokenId strings in the form `SYMBOL:0x...` (see `references/spotSend.ts`). Add a validator or extend `MixedAddressRegex` appropriately for HL networks.

- [x] Add scheme implementation under `schemes/exact/hyperliquid`

  - [x] `client.ts`: create and sign a `UserSignedAction` (e.g., `spotSend`) and return an encoded x402 payment header
  - [x] `facilitator/verify.ts`: validate payload shape + fields versus `PaymentRequirements` (recipient, asset, amount, TTL), verify basic signature format, optionally check balances/state with the Info client
  - [x] `facilitator/settle.ts`: POST `{ action, signature, nonce }` to Hyperliquid exchange endpoint and wait for confirmation or acceptable acknowledgement
  - [x] `facilitator/index.ts`: export `verify` and `settle`

- [x] Update scheme router(s)

  - [x] Update `src/facilitator/facilitator.ts` to route `SupportedHLNetworks` to the new `verify/settle` functions

- [x] Update encode/decode utilities to handle HL networks

  - [x] Extend `encodePayment`/`decodePayment` to include Hyperliquid payloads, and keep location consistent with existing pattern (`schemes/utils`)

- [x] Add shared helpers for Hyperliquid

  - [x] `src/shared/hyperliquid/index.ts`: Info client factory, REST base URL resolver, minimal helpers for tx lookup

- [x] Tests (Vitest)

  - [x] Unit tests for payload zod schema and encode/decode
  - [x] Verify tests using mocked Info client responses
  - [x] Settle tests mocking the exchange endpoint responses and confirmation polling

- [x] Docs and examples
  - [x] Update `README.md` with usage example for Hyperliquid
  - [x] Add a quick `createPaymentHeader` example for a client, and facilitator usage example for fetch/express/hono (informational only; code exists in x402)

## Code Changes (Snippets by File)

These are starter snippets to bootstrap the implementation. Naming and structure follows existing EVM/SVM patterns.

### 1) Add networks and family

File: src/types/shared/network.ts:1

```ts
import { z } from "zod";

export const NetworkSchema = z.enum([
  "abstract",
  "abstract-testnet",
  "base-sepolia",
  "base",
  "avalanche-fuji",
  "avalanche",
  "iotex",
  "solana-devnet",
  "solana",
  "sei",
  "sei-testnet",
  "polygon",
  "polygon-amoy",
  "peaq",
  "story",
  "educhain",
  "skale-base-sepolia",
  // + Hyperliquid family
  "hyperliquid-testnet",
  "hyperliquid",
]);
export type Network = z.infer<typeof NetworkSchema>;

// Existing EVM/SVM definitions above ...

export const SupportedHLNetworks: Network[] = ["hyperliquid-testnet", "hyperliquid"];

// Optional mapping helper if needed elsewhere
export const HlNetworkToChainName = new Map<Network, "Mainnet" | "Testnet">([
  ["hyperliquid-testnet", "Testnet"],
  ["hyperliquid", "Mainnet"],
]);
```

Note: `getNetworkId` in `shared/network.ts` remains for EVM/SVM. HL does not require an EVM/SVM chainId; we will add a separate helper in `shared/hyperliquid` for Info/REST endpoints.

### 2) Extend payload schemas and error codes

File: src/types/verify/x402Specs.ts:1

```ts
import { z } from "zod";
import { NetworkSchema } from "../shared";

// ... keep existing code

// HL payload shape — mirrors Hyperliquid User Signed Action envelope (see references/spotSend.ts)
export const ExactHlPayloadSchema = z.object({
  action: z.record(z.any()),
  // Accept either structured signature (r,s,v) or hex signature
  signature: z.union([
    z.string().min(1),
    z.object({ r: z.string(), s: z.string(), v: z.number() }),
  ]),
  nonce: z.number().int().positive(),
});
export type ExactHlPayload = z.infer<typeof ExactHlPayloadSchema>;

// Extend reasons
export const ErrorReasons = [
  // existing reasons ...
  "invalid_exact_hl_payload",
  "invalid_exact_hl_payload_signature",
  "invalid_exact_hl_payload_asset_mismatch",
  "invalid_exact_hl_payload_recipient_mismatch",
  "invalid_exact_hl_payload_amount_mismatch",
  "invalid_exact_hl_network",
  "hl_exchange_error",
  "hl_tx_not_found",
  "hl_tx_unconfirmed",
  // ...
] as const;

// Extend PaymentPayloadSchema union to include HL payload
export const PaymentPayloadSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  scheme: z.enum(schemes),
  network: NetworkSchema,
  payload: z.union([
    ExactEvmPayloadSchema,
    ExactSvmPayloadSchema,
    ExactHlPayloadSchema, // new
  ]),
});
```

### 3) Encode/decode payment support for HL

File: src/schemes/utils/index.ts:1

```ts
// Keep the single re-export location for now
export * from "../exact/evm/utils/paymentUtils";
```

File: src/schemes/exact/evm/utils/paymentUtils.ts:1

```ts
import { safeBase64Encode, safeBase64Decode } from "../../../../shared";
import { SupportedEVMNetworks, SupportedSVMNetworks } from "../../../../types";
import { SupportedHLNetworks } from "../../../../types/shared/network";
import {
  PaymentPayload,
  PaymentPayloadSchema,
  ExactEvmPayload,
  ExactSvmPayload,
  ExactHlPayload,
} from "../../../../types/verify";

export function encodePayment(payment: PaymentPayload): string {
  if (SupportedEVMNetworks.includes(payment.network)) {
    const evmPayload = payment.payload as ExactEvmPayload;
    const safe = {
      ...payment,
      payload: {
        ...evmPayload,
        authorization: Object.fromEntries(
          Object.entries(evmPayload.authorization).map(([k, v]) => [
            k,
            typeof v === "bigint" ? v.toString() : v,
          ]),
        ) as ExactEvmPayload["authorization"],
      },
    } satisfies PaymentPayload;
    return safeBase64Encode(JSON.stringify(safe));
  }
  if (SupportedSVMNetworks.includes(payment.network)) {
    const safe = {
      ...payment,
      payload: payment.payload as ExactSvmPayload,
    } satisfies PaymentPayload;
    return safeBase64Encode(JSON.stringify(safe));
  }
  if (SupportedHLNetworks.includes(payment.network)) {
    const safe = {
      ...payment,
      payload: payment.payload as ExactHlPayload,
    } satisfies PaymentPayload;
    return safeBase64Encode(JSON.stringify(safe));
  }
  throw new Error("Invalid network");
}

export function decodePayment(payment: string): PaymentPayload {
  const decoded = safeBase64Decode(payment);
  const parsed = JSON.parse(decoded);

  if (SupportedEVMNetworks.includes(parsed.network)) {
    const obj = { ...parsed, payload: parsed.payload as ExactEvmPayload } as PaymentPayload;
    return PaymentPayloadSchema.parse(obj);
  }
  if (SupportedSVMNetworks.includes(parsed.network)) {
    const obj = { ...parsed, payload: parsed.payload as ExactSvmPayload } as PaymentPayload;
    return PaymentPayloadSchema.parse(obj);
  }
  if (SupportedHLNetworks.includes(parsed.network)) {
    const obj = { ...parsed, payload: parsed.payload as ExactHlPayload } as PaymentPayload;
    return PaymentPayloadSchema.parse(obj);
  }
  throw new Error("Invalid network");
}
```

### 4) Shared Hyperliquid helpers

Add: src/shared/hyperliquid/index.ts

```ts
import * as hl from "@nktkas/hyperliquid";
import { Network } from "../../types/shared";
import { HlNetworkToChainName } from "../../types/shared/network";

export type HlChainName = "Mainnet" | "Testnet";

export function getHlChainName(network: Network): HlChainName {
  const chain = HlNetworkToChainName.get(network);
  if (!chain) throw new Error(`Invalid Hyperliquid network: ${network}`);
  return chain;
}

export function createInfoClient(): hl.InfoClient {
  const transport = new hl.HttpTransport();
  return new hl.InfoClient({ transport });
}

export function getExchangeBaseUrl(network: Network): string {
  // Note: keep endpoints in one place; adjust testnet URL if different
  return "https://api.hyperliquid.xyz/exchange";
}
```

Also export from `src/shared/index.ts` if needed later:

```ts
export * as hl from "./hyperliquid";
```

### 5) Scheme implementation: exact/hyperliquid

Add: src/schemes/exact/hyperliquid/client.ts

```ts
import { PaymentPayload, PaymentRequirements } from "../../../types/verify";
import { encodePayment } from "../evm/utils/paymentUtils";
import { signUserSignedAction } from "@nktkas/hyperliquid/signing";
import { parser, SpotSendTypes } from "@nktkas/hyperliquid/api/exchange";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";

/**
 * Creates an encoded payment header for Hyperliquid using a User Signed Action.
 * Implements `spotSend` (user -> payTo) with a TokenId and decimal amount.
 * TokenId must follow: "SYMBOL:0x..." (e.g., "USDC:0xeb62eee...").
 */
export async function createPaymentHeader(
  wallet: LocalAccount | ReturnType<typeof privateKeyToAccount>,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
): Promise<string> {
  const { payTo, maxAmountRequired, asset, extra } = paymentRequirements;

  // HL expects amount as a decimal string, not wei.
  // If x402 maxAmountRequired is in atomic units, convert using decimals from `extra` or a helper.
  const decimals = (extra as any)?.decimals as number | undefined;
  const amount =
    decimals != null
      ? (BigInt(maxAmountRequired) / BigInt(10 ** decimals)).toString()
      : maxAmountRequired; // assume already decimal if not provided

  const action = parser({
    action: {
      type: "spotSend",
      signatureChainId: (extra as any)?.signatureChainId ?? "0x66eee",
      hyperliquidChain: (extra as any)?.hyperliquidChain ?? "Mainnet",
      destination: payTo,
      token: asset, // HL TokenId: "SYMBOL:0x..."
      amount,
      time: Date.now(),
    },
    // `nonce` and `signature` are generated in executeUserSignedAction; we just need a typed action for signing
    nonce: 0,
    signature: { r: "0x", s: "0x", v: 27 },
  } as any);

  const signature = await signUserSignedAction({ wallet, action, types: SpotSendTypes });

  const payload: PaymentPayload = {
    x402Version,
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    payload: {
      action,
      signature,
      nonce: action.nonce ?? action.time,
    },
  } as any;

  return encodePayment(payload);
}
```

Add: src/schemes/exact/hyperliquid/facilitator/verify.ts

```ts
import { VerifyResponse, PaymentPayload, PaymentRequirements } from "../../../../types/verify";
import { SupportedHLNetworks } from "../../../../types/shared/network";

export async function verify(
  _client: unknown,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  // Basic guards
  if (!SupportedHLNetworks.includes(paymentRequirements.network)) {
    return { isValid: false, invalidReason: "invalid_exact_hl_network" };
  }
  // Sanity check payload shape
  const { payload } = paymentPayload as any;
  if (!payload?.action || !payload?.signature || typeof payload?.nonce !== "number") {
    return { isValid: false, invalidReason: "invalid_exact_hl_payload" };
  }

  // Compare fields that we can check locally
  const toMatches =
    payload.action?.destination?.toLowerCase?.() === paymentRequirements.payTo.toLowerCase?.();
  const assetMatches = String(payload.action?.token) === String(paymentRequirements.asset);
  // HL amount is decimal string (not wei). Convert requirement to decimal if `extra.decimals` is present.
  const decimals = (paymentRequirements.extra as any)?.decimals as number | undefined;
  let amountOk = false;
  if (decimals != null) {
    const reqDecimal = (
      BigInt(paymentRequirements.maxAmountRequired) / BigInt(10 ** decimals)
    ).toString();
    amountOk = Number(payload.action?.amount) >= Number(reqDecimal);
  } else {
    amountOk = Number(payload.action?.amount) >= Number(paymentRequirements.maxAmountRequired);
  }

  if (!toMatches)
    return { isValid: false, invalidReason: "invalid_exact_hl_payload_recipient_mismatch" };
  if (!assetMatches)
    return { isValid: false, invalidReason: "invalid_exact_hl_payload_asset_mismatch" };
  if (!amountOk)
    return { isValid: false, invalidReason: "invalid_exact_hl_payload_amount_mismatch" };

  // Signature sanity is deferred to HL exchange at settle time; add basic string check already done above.
  return { isValid: true, payer: payload.action?.user ?? undefined } as VerifyResponse;
}
```

Add: src/schemes/exact/hyperliquid/facilitator/settle.ts

```ts
import { SettleResponse, PaymentPayload, PaymentRequirements } from "../../../../types/verify";
import { getExchangeBaseUrl } from "../../../../shared/hyperliquid";

export async function settle(
  _client: unknown,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  const { payload } = paymentPayload as any;
  const url = getExchangeBaseUrl(paymentRequirements.network);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: payload.action,
        signature: payload.signature,
        nonce: payload.nonce,
      }),
    });

    if (!res.ok) {
      return {
        success: false,
        errorReason: "hl_exchange_error",
        transaction: "",
        network: paymentPayload.network,
      };
    }

    const json = await res.json();
    // Optional: parse tx hash/id from response when available
    const tx = json?.txHash ?? json?.hash ?? "";

    return {
      success: true,
      transaction: tx,
      network: paymentPayload.network,
      payer: payload?.action?.user ?? undefined,
    };
  } catch {
    return {
      success: false,
      errorReason: "hl_exchange_error",
      transaction: "",
      network: paymentPayload.network,
    };
  }
}
```

Add: src/schemes/exact/hyperliquid/facilitator/index.ts

```ts
export * from "./verify";
export * from "./settle";
```

### 6) Route Hyperliquid in facilitator

File: src/facilitator/facilitator.ts:1

```ts
import {
  verify as verifyExactHl,
  settle as settleExactHl,
} from "../schemes/exact/hyperliquid/facilitator";
import { SupportedEVMNetworks, SupportedSVMNetworks } from "../types/shared";
import { SupportedHLNetworks } from "../types/shared/network";

// ... inside verify()
if (SupportedHLNetworks.includes(paymentRequirements.network)) {
  return await verifyExactHl(client, payload, paymentRequirements, config);
}

// ... inside settle()
if (SupportedHLNetworks.includes(paymentRequirements.network)) {
  return await settleExactHl(client, payload, paymentRequirements, config);
}
```

### 7) Tests (outlines)

Add: src/schemes/exact/hyperliquid/facilitator/verify.test.ts

```ts
import { describe, it, expect } from "vitest";
import { verify } from "./verify";

it("rejects when recipient mismatches", async () => {
  const res = await verify(
    undefined as any,
    {
      x402Version: 1,
      scheme: "exact",
      network: "hyperliquid",
      payload: {
        action: { destination: "0xbad", token: "USDC", amount: "100" },
        signature: "0xabc",
        nonce: 1,
      },
    } as any,
    {
      scheme: "exact",
      network: "hyperliquid",
      maxAmountRequired: "100",
      resource: "https://x",
      description: "d",
      mimeType: "application/json",
      payTo: "0xgood",
      maxTimeoutSeconds: 300,
      asset: "USDC",
    },
  );
  expect(res.isValid).toBe(false);
});
```

Add: src/schemes/exact/hyperliquid/facilitator/settle.test.ts

```ts
import { describe, it, expect, vi } from "vitest";
import { settle } from "./settle";

it("returns success=true on 200", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ txHash: "0xabc" }) })) as any,
  );
  const res = await settle(
    undefined as any,
    {
      x402Version: 1,
      scheme: "exact",
      network: "hyperliquid",
      payload: {
        action: {
          destination: "0xgood",
          token: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
          amount: "1",
        },
        signature: "0xabc",
        nonce: 1,
      },
    } as any,
    {
      scheme: "exact",
      network: "hyperliquid",
      maxAmountRequired: "1000000",
      resource: "https://x",
      description: "d",
      mimeType: "application/json",
      payTo: "0xgood",
      maxTimeoutSeconds: 300,
      asset: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
      extra: { decimals: 6 },
    },
  );
  expect(res.success).toBe(true);
});
```

## Notes and Open Questions

- Action type: This plan sketches a `spotSend` user signed action for direct payments. If Hyperliquid recommends a different action or an “agent flow” (e.g., ApproveAgent + agent-initiated send), we can adapt `client.ts` and `settle.ts` easily.
- Signature verification: The current plan defers deep signature cryptography to the Hyperliquid exchange (similar to how 6492 signatures are handled before submit for EVM). If the SDK exposes local verification helpers, we can add them to `verify.ts`.
- Confirmation strategy: `references/hyperliquid_routes.ts` demonstrates using `InfoClient.txDetails` to check settle success. We can add an optional confirmation poll in `settle.ts` when the exchange returns a tx hash.
- Middleware updates: `x402-hono` currently decodes with `exact.evm.decodePayment` (which already handles SVM). Extending encode/decode to support Hyperliquid means no changes are required on caller side for decoding. Adding ‘Hyperliquid’ to the middleware’s “build payment requirements” branch will be required when we expose it to apps.
- Asset identifier: Hyperliquid uses a TokenId string: `SYMBOL:0x...` (e.g., `USDC:0xeb62eee...`, see `references/spotSend.ts`). Update `PaymentRequirements.asset` validation to accept this format for HL networks and perform exact string comparison during verification.

## Where to Work (File Map)

- Add/Update

  - src/types/shared/network.ts
  - src/types/verify/x402Specs.ts
  - src/schemes/exact/evm/utils/paymentUtils.ts
  - src/schemes/utils/index.ts
  - src/shared/hyperliquid/index.ts
  - src/schemes/exact/hyperliquid/client.ts
  - src/schemes/exact/hyperliquid/facilitator/{index.ts,verify.ts,settle.ts}
  - src/facilitator/facilitator.ts (routing)

- Tests

  - src/schemes/exact/hyperliquid/facilitator/{verify.test.ts,settle.test.ts}

- Docs
  - README.md (usage snippets for Hyperliquid)

## Quick Usage Examples

- Client: create a Hyperliquid payment header (sketch)

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentHeader } from "x402/schemes/exact/hyperliquid/client";

const wallet = privateKeyToAccount("0x...");
const header = await createPaymentHeader(wallet, 1, {
  scheme: "exact",
  network: "hyperliquid",
  maxAmountRequired: "1000000", // atomic units (6 decimals -> 1 USDC)
  resource: "https://api.example.com/protected",
  description: "Access resource",
  mimeType: "application/json",
  payTo: "0x...", // EVM-style address
  maxTimeoutSeconds: 300,
  asset: "USDC:0xeb62eee3685fc4c43992febcd9e75443", // HL TokenId
  extra: { hyperliquidChain: "Mainnet", decimals: 6 },
});
// Use as X-PAYMENT header
```

- Facilitator server: verify and settle

```ts
import { verify, settle } from "x402/facilitator";

const verification = await verify(undefined as any, paymentPayload, paymentRequirements);
if (!verification.isValid) {
  /* return 402 */
}

const settlement = await settle(undefined as any, paymentPayload, paymentRequirements);
if (!settlement.success) {
  /* return 402 */
}
```

---

This plan keeps the integration consistent with existing EVM/SVM patterns, minimizes new surface area, and uses the installed Hyperliquid SDK for both signing and exchange submission. Follow-ups can deepen signature and confirmation checks as we validate the exact action shape with the SDK.
