import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { settle } from "./settle";
import { ExactHlPayload, PaymentPayload, PaymentRequirements } from "../../../../types/verify";

const TX_HASH = "0x" + "2".repeat(64);
const originalFetch = globalThis.fetch;

type Scenario = "success" | "not_found" | "timeout";
let scenario: Scenario = "success";
let userDetailsTxs: Array<Record<string, unknown>> = [];

const TIMESTAMP = 1_700_000_000_000;

const baseRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "hyperliquid",
  maxAmountRequired: "1000000",
  resource: "https://example.com/resource",
  description: "Test",
  mimeType: "application/json",
  payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  maxTimeoutSeconds: 300,
  asset: "USDC:0xeb62eee3685fc4c43992febcd9e75443",
  extra: { decimals: 6 },
};

const payerAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type HyperliquidPaymentPayload = PaymentPayload & { payload: ExactHlPayload };

const basePayload: HyperliquidPaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: "hyperliquid",
  payload: {
    action: {
      type: "spotSend",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Testnet",
      destination: baseRequirements.payTo,
      token: baseRequirements.asset,
      amount: "1",
      time: TIMESTAMP,
    },
    signature: "0x" + "1".repeat(130),
    nonce: TIMESTAMP,
    user: payerAddress,
  },
};

describe("hyperliquid settle", () => {
  beforeEach(() => {
    scenario = "success";
    userDetailsTxs = [buildUserTx()];
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("settles successfully when exchange and confirmation succeed", async () => {
    const result = await settle(undefined, basePayload, baseRequirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe(TX_HASH);
    expect(result.payer).toBe(payerAddress);
  });

  it("returns hl_tx_not_found when no matching tx hash is in userDetails", async () => {
    userDetailsTxs = [buildUserTx({ destination: "0xcccccccccccccccccccccccccccccccccccccccc" })];
    const result = await settle(undefined, basePayload, baseRequirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("hl_tx_not_found");
    expect(result.transaction).toBe(TX_HASH);
  });

  it("returns hl_tx_not_found when confirmation endpoint returns not found", async () => {
    scenario = "not_found";
    const result = await settle(undefined, basePayload, baseRequirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("hl_tx_not_found");
    expect(result.transaction).toBe(TX_HASH);
  });

  it("returns hl_tx_unconfirmed when confirmation keeps timing out", async () => {
    scenario = "timeout";
    const result = await settle(undefined, basePayload, baseRequirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("hl_tx_unconfirmed");
  });
});

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = request.url;
  const rawBody = request.method === "POST" ? await request.clone().text() : "";
  const body = rawBody ? JSON.parse(rawBody) : undefined;

  if (url.includes("/exchange")) {
    return jsonResponse({
      status: "ok",
      response: { type: "default" },
      txHash: TX_HASH,
    });
  }

  if (url.includes("/explorer")) {
    if (body?.type === "userDetails") {
      return jsonResponse({
        type: "userDetails",
        txs: userDetailsTxs,
      });
    }

    if (body?.type === "txDetails") {
      if (scenario === "success") {
        return jsonResponse({
          type: "txDetails",
          tx: {
            action: { type: "spotSend" },
            block: 1,
            error: null,
            hash: body.hash,
            time: TIMESTAMP,
            user: payerAddress,
          },
        });
      }

      const message =
        scenario === "not_found" ? "transaction not found" : "temporary confirmation error";
      return jsonResponse({
        type: "error",
        message,
      });
    }
  }

  throw new Error(`Unhandled fetch url: ${url}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildUserTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: TX_HASH,
    time: TIMESTAMP,
    action: {
      ...basePayload.payload.action,
      ...overrides,
    },
  };
}
