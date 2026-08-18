import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Signal } from "@dodash/domain";

import { allocateSignals } from "../src/index.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid product fixture");

const signal = (
  strategyId: string,
  side: Signal["side"],
  confidence: number,
  suggestedSize: number,
): Signal => {
  const result = createSignal({
    strategyId,
    productId: productResult.value,
    side,
    confidence,
    suggestedSize,
    reasonCode: "TEST",
  });
  if (!result.ok) throw new Error("invalid signal fixture");
  return result.value;
};

const base = {
  agentId: "btc-agent",
  cycleId: "cycle-1",
  decisionId: "decision-1",
  marketPrices: { "BTC-USD": 50_000 },
  capitalAvailable: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
} as const;

describe("allocateSignals", () => {
  it("retourne NO_ACTION quand tous les signaux sont HOLD", () => {
    const result = allocateSignals({
      ...base,
      signals: [signal("rsi", "HOLD", 0.5, 0)],
    });
    expect(result.ok && result.value.outcome).toBe("NO_ACTION");
    expect(result.ok && result.value.orders).toHaveLength(0);
  });

  it("arbitre les signaux opposés en une seule intention", () => {
    const result = allocateSignals({
      ...base,
      signals: [
        signal("rsi", "BUY", 0.9, 0.1),
        signal("ema", "SELL", 0.5, 0.1),
      ],
    });
    expect(result.ok && result.value.orders).toHaveLength(1);
    expect(result.ok && result.value.orders[0]?.side).toBe("BUY");
    expect(result.ok && result.value.orders[0]?.quantity).toBeCloseTo(0.04, 10);
  });

  it("plafonne l’allocation par le notional disponible", () => {
    const result = allocateSignals({
      ...base,
      capitalAvailable: 1_000,
      signals: [signal("rsi", "BUY", 1, 1)],
    });
    expect(result.ok && result.value.orders[0]?.quantity).toBeCloseTo(0.02, 10);
  });

  it("produit le même identifiant à entrée identique", () => {
    const input = { ...base, signals: [signal("rsi", "BUY", 1, 0.01)] };
    const first = allocateSignals(input);
    const second = allocateSignals(input);
    expect(first.ok && first.value.orders[0]?.clientOrderId).toBe(
      second.ok ? second.value.orders[0]?.clientOrderId : undefined,
    );
  });
});

