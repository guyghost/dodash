import { describe, expect, it } from "vitest";

import { createProductId, createSignal } from "@dodash/domain";
import type { Strategy, StrategyContext } from "@dodash/strategies";

import { withConfidenceCalibration } from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const context = {
  productId: product.value,
  candles: [{ start: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 }],
  indicators: {},
  previousIndicators: null,
} as unknown as StrategyContext;

const strategy = (side: "BUY" | "HOLD"): Strategy => ({
  id: "calibrated",
  evaluate: () => {
    const result = createSignal({
      strategyId: "calibrated",
      productId: product.value,
      side,
      confidence: side === "HOLD" ? 0 : 1 / 64,
      suggestedSize: side === "HOLD" ? 0 : 7,
      reasonCode: side === "HOLD" ? "NO_ACTION" : "ACTIVE",
    });
    return result.ok
      ? result
      : {
          ok: false as const,
          error: {
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: "calibrated",
            cause: result.error,
          },
        };
  },
});

describe("withConfidenceCalibration", () => {
  it("ne change que la confiance d'un signal actif", () => {
    const raw = strategy("BUY").evaluate(context);
    const calibrated = withConfidenceCalibration(
      strategy("BUY"),
      "POWER_THIRD",
    ).evaluate(context);

    expect(raw.ok).toBe(true);
    expect(calibrated.ok).toBe(true);
    if (!raw.ok || !calibrated.ok) return;
    expect(calibrated.value).toEqual({
      ...raw.value,
      confidence: 0.25,
    });
  });

  it("retourne un HOLD sans modification", () => {
    const rawStrategy = strategy("HOLD");
    const raw = rawStrategy.evaluate(context);
    const calibrated = withConfidenceCalibration(
      rawStrategy,
      "POWER_QUARTER",
    ).evaluate(context);

    expect(calibrated).toEqual(raw);
  });
});
