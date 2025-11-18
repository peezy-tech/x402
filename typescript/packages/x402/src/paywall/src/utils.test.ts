import { describe, expect, it, afterEach } from "vitest";
import { ensureValidAmount } from "./utils";
import type { PaymentRequirements } from "../../types";

const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.window = originalWindow;
});

describe("ensureValidAmount", () => {
  it("uses provided decimals to compute amount from window.x402", () => {
    globalThis.window = {
      x402: { amount: 1.5 },
    } as any;

    const paymentRequirements = {
      scheme: "exact",
      network: "hyperliquid",
      maxAmountRequired: "0",
      resource: "https://example.com",
      description: "",
      mimeType: "application/json",
      payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      maxTimeoutSeconds: 300,
      asset: "0xc4bf3f870c0e9465323c0b6ed28096c2",
      extra: { decimals: 3 },
    } as PaymentRequirements;

    const updated = ensureValidAmount(paymentRequirements);
    expect(updated.maxAmountRequired).toBe("1500");
  });
});
