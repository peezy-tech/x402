import { describe, expect, it, vi } from "vitest";
import { createPaymentPayload } from "./client";
import type { PaymentRequirements } from "../../../types/verify";

vi.mock("@nktkas/hyperliquid/api/exchange", () => ({
  parser: () => (value: any) => value,
  SpotSendRequest: {},
  SpotSendTypes: {},
}));

vi.mock("@nktkas/hyperliquid/signing", () => ({
  signUserSignedAction: vi.fn().mockResolvedValue({ r: "0x1", s: "0x2", v: 27 }),
}));

vi.mock("../../../shared/hyperliquid", async importOriginal => {
  const actual = (await importOriginal()) as typeof import("../../../shared/hyperliquid");
  return {
    ...actual,
    fetchHyperliquidTokenInfo: vi.fn().mockResolvedValue({ decimals: 3 }),
  };
});

describe("hyperliquid client createPaymentPayload", () => {
  it("formats amount using resolved decimals", async () => {
    const paymentRequirements: PaymentRequirements = {
      scheme: "exact",
      network: "hyperliquid-testnet",
      maxAmountRequired: "1234",
      resource: "https://example.com",
      description: "desc",
      mimeType: "application/json",
      payTo: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      maxTimeoutSeconds: 300,
      asset: "0xc4bf3f870c0e9465323c0b6ed28096c2",
    };

    const payload = await createPaymentPayload(
      { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } as any,
      1,
      paymentRequirements,
    );

    const action = (payload.payload as any).action;
    expect(action.amount).toBe("1.234");
  });
});
