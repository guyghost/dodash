import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Signal } from "@dodash/domain";

import { allocateSignals } from "../src/index.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid product fixture");
const ethProductResult = createProductId("ETH-USD");
if (!ethProductResult.ok) throw new Error("invalid eth product fixture");

const signal = (
  strategyId: string,
  side: Signal["side"],
  confidence: number,
  suggestedSize: number,
  productId = productResult.value,
): Signal => {
  const result = createSignal({
    strategyId,
    productId,
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
    expect(first.ok && first.value.orders[0]?.type).toBe("MARKET");
    expect(first.ok && first.value.orders[0]?.limitPrice).toBeNull();
  });

  it("émet un ordre LIMIT au bestBid pour un BUY en mode LIMIT_PASSIVE", () => {
    const result = allocateSignals({
      ...base,
      signals: [signal("rsi", "BUY", 1, 0.05)],
      executionStyle: "LIMIT_PASSIVE",
      orderBooks: {
        "BTC-USD": { bestBid: 49_990, bestAsk: 50_010, spreadBps: 4 },
      },
    });
    expect(result.ok && result.value.outcome).toBe("ALLOCATED");
    if (!result.ok) return;
    expect(result.value.orders[0]?.type).toBe("LIMIT");
    expect(result.value.orders[0]?.limitPrice).toBe(49_990);
  });

  it("émet un ordre LIMIT au bestAsk pour un SELL en mode LIMIT_PASSIVE", () => {
    const result = allocateSignals({
      ...base,
      signals: [signal("rsi", "SELL", 1, 0.05)],
      executionStyle: "LIMIT_PASSIVE",
      orderBooks: {
        "BTC-USD": { bestBid: 49_990, bestAsk: 50_010, spreadBps: 4 },
      },
    });
    expect(result.ok && result.value.outcome).toBe("ALLOCATED");
    if (!result.ok) return;
    expect(result.value.orders[0]?.type).toBe("LIMIT");
    expect(result.value.orders[0]?.limitPrice).toBe(50_010);
  });

  it("se replie explicitement sur MARKET si LIMIT_PASSIVE sans carnet valide", () => {
    const missingBook = allocateSignals({
      ...base,
      signals: [signal("rsi", "BUY", 1, 0.05)],
      executionStyle: "LIMIT_PASSIVE",
    });
    expect(missingBook.ok && missingBook.value.orders[0]?.type).toBe("MARKET");
    expect(missingBook.ok && missingBook.value.orders[0]?.limitPrice).toBeNull();

    const crossedBook = allocateSignals({
      ...base,
      signals: [signal("rsi", "BUY", 1, 0.05)],
      executionStyle: "LIMIT_PASSIVE",
      orderBooks: {
        "BTC-USD": { bestBid: 50_020, bestAsk: 50_000, spreadBps: 4 },
      },
    });
    expect(crossedBook.ok && crossedBook.value.orders[0]?.type).toBe("MARKET");
    expect(crossedBook.ok && crossedBook.value.orders[0]?.limitPrice).toBeNull();
  });

  it("ignore un produit dont le spread dépasse maxSpreadBps sans consommer le budget", () => {
    const result = allocateSignals({
      ...base,
      marketPrices: { "BTC-USD": 50_000, "ETH-USD": 2_000 },
      capitalAvailable: 1_000,
      maxDecisionNotional: 1_000,
      signals: [
        signal("rsi", "BUY", 1, 1, productResult.value),
        signal("rsi", "BUY", 1, 0.5, ethProductResult.value),
      ],
      executionStyle: "LIMIT_PASSIVE",
      maxSpreadBps: 10,
      orderBooks: {
        "BTC-USD": { bestBid: 49_900, bestAsk: 50_100, spreadBps: 40 },
        "ETH-USD": { bestBid: 1_999, bestAsk: 2_001, spreadBps: 10 },
      },
    });
    expect(result.ok && result.value.outcome).toBe("ALLOCATED");
    if (!result.ok) return;
    expect(result.value.orders).toHaveLength(1);
    expect(result.value.orders[0]?.productId).toBe("ETH-USD");
    expect(result.value.orders[0]?.type).toBe("LIMIT");
    expect(result.value.orders[0]?.limitPrice).toBe(1_999);
    // Le budget de 1_000 n'a pas été consommé par BTC-USD
    expect(result.value.orders[0]?.quantity).toBeCloseTo(0.5, 10);
  });

  it("retourne NO_ACTION si le seul produit est bloqué par maxSpreadBps", () => {
    const result = allocateSignals({
      ...base,
      signals: [signal("rsi", "BUY", 1, 0.05)],
      maxSpreadBps: 5,
      orderBooks: {
        "BTC-USD": { bestBid: 49_950, bestAsk: 50_050, spreadBps: 20 },
      },
    });
    expect(result.ok && result.value.outcome).toBe("NO_ACTION");
    expect(result.ok && result.value.orders).toHaveLength(0);
  });

  it("rejette fail-closed un maxSpreadBps négatif ou non fini", () => {
    expect(
      allocateSignals({
        ...base,
        signals: [signal("rsi", "BUY", 1, 0.05)],
        maxSpreadBps: -1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ALLOCATION_CONFIG" },
    });
    expect(
      allocateSignals({
        ...base,
        signals: [signal("rsi", "BUY", 1, 0.05)],
        maxSpreadBps: Number.NaN,
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_ALLOCATION_CONFIG" },
    });
  });
});

