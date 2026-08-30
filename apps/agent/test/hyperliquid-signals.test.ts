import { describe, expect, it } from "vitest";

import {
  admitHyperliquidPerpAgent,
  parseAgentConfiguration,
} from "../src/configuration.js";
import {
  HYPERLIQUID_SIGNAL_MAP,
  perpProductForSignal,
  toPerpIntent,
} from "../src/hyperliquid-control.js";
import { HYPERLIQUID_PERP_POLICY } from "@dodash/models";

const perpRequest = {
  productId: "BTC-USD",
  executionMode: "perp",
};

describe("configuration perp", () => {
  it("force les défauts de l'enveloppe figée", () => {
    const parsed = parseAgentConfiguration(perpRequest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.timeframe).toBe(HYPERLIQUID_PERP_POLICY.timeframe);
    expect(parsed.value.intervalSeconds).toBe(3_600);
    expect(parsed.value.maxDecisionNotional).toBe(
      HYPERLIQUID_PERP_POLICY.risk.maxOrderNotional,
    );
    expect(parsed.value.risk).toEqual({
      maxOrderNotional: 600,
      maxPositionNotional: 10_000,
      maxGrossExposure: 10_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    });
  });

  it("approuve l'enveloppe exacte sur un produit miroir", () => {
    const parsed = parseAgentConfiguration(perpRequest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(admitHyperliquidPerpAgent(parsed.value)).toEqual({
      status: "APPROVED",
    });
  });

  it("refuse un produit hors miroir", () => {
    const parsed = parseAgentConfiguration({
      productId: "SOL-USD",
      executionMode: "perp",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(admitHyperliquidPerpAgent(parsed.value)).toEqual({
      status: "REJECTED",
      reasonCode: "PERP_PRODUCT_NOT_ALLOWED",
    });
  });

  it("refuse un champ de risque divergent de l'enveloppe", () => {
    const parsed = parseAgentConfiguration({
      ...perpRequest,
      risk: { maxDailyLoss: 2_000 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(admitHyperliquidPerpAgent(parsed.value)).toEqual({
      status: "REJECTED",
      reasonCode: "PERP_POLICY_MISMATCH",
    });
  });

  it("refuse le mode perp appliqué à une configuration live", () => {
    const parsed = parseAgentConfiguration({
      productId: "BTC-USD",
      executionMode: "live",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(admitHyperliquidPerpAgent(parsed.value)).toEqual({
      status: "REJECTED",
      reasonCode: "PERP_POLICY_MISMATCH",
    });
  });
});

describe("conversion signal → intention perp", () => {
  it("mappe les produits miroirs", () => {
    expect(perpProductForSignal("BTC-USD")).toBe("BTC-PERP");
    expect(perpProductForSignal("ETH-USD")).toBe("ETH-PERP");
    expect(perpProductForSignal("SOL-USD")).toBeNull();
    expect(HYPERLIQUID_SIGNAL_MAP["BTC-USD"]).toBe("BTC-PERP");
  });

  it("convertit avec arrondi vers zéro et levier effectif 1", () => {
    const intent = toPerpIntent({
      intent: { productId: "BTC-USD", side: "SELL", quantity: 0.1234567 },
      markPrice: 100_000,
    });
    expect(intent).toEqual({
      productId: "BTC-PERP",
      side: "SELL",
      quantity: 0.12345,
      markPrice: 100_000,
      leverage: 1,
    });
  });

  it("abandonne une quantité sous un incrément", () => {
    expect(
      toPerpIntent({
        intent: { productId: "ETH-USD", side: "BUY", quantity: 0.00001 },
        markPrice: 4_000,
      }),
    ).toBeNull();
  });

  it("retourne null hors miroir", () => {
    expect(
      toPerpIntent({
        intent: { productId: "SOL-USD", side: "BUY", quantity: 1 },
        markPrice: 200,
      }),
    ).toBeNull();
  });
});
