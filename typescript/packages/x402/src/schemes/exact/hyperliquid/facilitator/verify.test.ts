import { describe, it, expect } from "vitest";
import { verify } from "./verify";
import { PaymentPayload, PaymentRequirements } from "../../../../types/verify";

const now = Date.now();

const baseRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "hyperliquid",
  maxAmountRequired: "1000000", // 1 USDC with 6 decimals
  resource: "https://example.com/protected",
  description: "Test",
  mimeType: "application/json",
  payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  maxTimeoutSeconds: 300,
  asset: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
  extra: { decimals: 6 },
};

const basePayload: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "hyperliquid",
  payload: {
    action: {
      destination: baseRequirements.payTo,
      token: baseRequirements.asset,
      amount: "1.5",
      time: now,
    },
    signature: "0x" + "1".repeat(130),
    nonce: 1,
  },
};

describe("hyperliquid verify", () => {
  it("accepts valid payloads", async () => {
    const result = await verify(undefined, basePayload, baseRequirements);
    expect(result.isValid).toBe(true);
  });

  it("rejects when asset mismatches", async () => {
    const payload = structuredClone(basePayload) as PaymentPayload;
    ((payload.payload as any).action).token = "USDT:0xeb62eee3685fc4c43992febcd9e75443";
    const result = await verify(undefined, payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hl_payload_asset_mismatch");
  });

  it("rejects when amount is below requirement", async () => {
    const payload = structuredClone(basePayload) as PaymentPayload;
    ((payload.payload as any).action).amount = "0.5";
    const result = await verify(undefined, payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_hl_payload_amount_mismatch");
  });

  it("rejects when ttl expired", async () => {
    const payload = structuredClone(basePayload) as PaymentPayload;
    ((payload.payload as any).action).time =
      Date.now() - (baseRequirements.maxTimeoutSeconds * 1000 + 1);
    const result = await verify(undefined, payload, baseRequirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("payment_expired");
  });
});
