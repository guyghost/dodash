import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import type { Strategy, StrategyContext } from "@dodash/strategies";

import { withTargetSignalNotional } from "../src/target-notional-strategy.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const candle: Candle = {
  start: 0,
  open: 250,
  high: 251,
  low: 249,
  close: 250,
  volume: 10,
};

const context: StrategyContext = {
  productId: product.value,
  candles: [candle],
  indicators: {} as StrategyContext["indicators"],
  previousIndicators: null,
};

const strategyFor = (side: "BUY" | "HOLD"): Strategy => ({
  id: "fixture",
  evaluate: () => {
    const signal = createSignal({
      strategyId: "fixture",
      productId: product.value,
      side,
      confidence: 0.5,
      suggestedSize: side === "HOLD" ? 0 : 99,
      reasonCode: "FIXTURE",
    });
    if (!signal.ok) throw new Error("invalid signal fixture");
    return signal;
  },
});

describe("target-notional strategy adapter", () => {
  it("remplace la quantité du signal actif au prix primaire courant", () => {
    const result = withTargetSignalNotional(strategyFor("BUY"), 1_000).evaluate(
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedSize).toBe(4);
    expect(result.value.confidence).toBe(0.5);
  });

  it("préserve un HOLD à taille nulle", () => {
    const result = withTargetSignalNotional(strategyFor("HOLD"), 1_000).evaluate(
      context,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedSize).toBe(0);
  });

  it("transforme un prix primaire invalide en signal invalide", () => {
    const result = withTargetSignalNotional(strategyFor("BUY"), 1_000).evaluate({
      ...context,
      candles: [{ ...candle, close: 0 }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_STRATEGY_SIGNAL",
        strategyId: "fixture",
        cause: { code: "INVALID_SUGGESTED_SIZE" },
      },
    });
  });
});
