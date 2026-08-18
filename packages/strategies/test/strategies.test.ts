import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";

import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
} from "../src/index.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid fixture product");

const snapshot = (overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot => ({
  snapshotId: "snapshot",
  candleClosedAt: 1_000,
  rsi: 50,
  emaFast: 100,
  emaSlow: 100,
  macd: 0,
  atr: 2,
  ...overrides,
});

const candles = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  }));

const context = (overrides: Record<string, unknown> = {}) => ({
  productId: productResult.value,
  candles: candles([100, 101, 102, 103]),
  indicators: snapshot(),
  previousIndicators: null,
  ...overrides,
});

describe("strategies", () => {
  it("achète un RSI survendu", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
    });
    const result = strategy.evaluate(context({ indicators: snapshot({ rsi: 20 }) }));
    expect(result.ok && result.value.side).toBe("BUY");
    expect(result.ok && result.value.reasonCode).toBe("RSI_OVERSOLD");
  });

  it("n’agit que sur un croisement EMA confirmé", () => {
    const strategy = createEmaCrossStrategy({ baseSize: 0.01 });
    const result = strategy.evaluate(
      context({
        previousIndicators: snapshot({ emaFast: 99, emaSlow: 100 }),
        indicators: snapshot({ emaFast: 101, emaSlow: 100 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
  });

  it("détecte un breakout contre la fenêtre précédente", () => {
    const strategy = createBreakoutStrategy({ lookback: 3, baseSize: 0.01 });
    const result = strategy.evaluate(
      context({ candles: candles([100, 101, 102, 110]) }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
  });

  it("évalue le registre dans un ordre stable", () => {
    const registry = createStrategyRegistry([
      createRsiReversionStrategy({
        id: "z-rsi",
        oversold: 30,
        overbought: 70,
        baseSize: 0.01,
      }),
      createEmaCrossStrategy({ id: "a-ema", baseSize: 0.01 }),
    ]);
    expect(registry.ok && registry.value.ids).toEqual(["a-ema", "z-rsi"]);
    const result = registry.ok ? registry.value.evaluateAll(context()) : registry;
    expect(result.ok && result.value.map((signal) => signal.strategyId)).toEqual([
      "a-ema",
      "z-rsi",
    ]);
  });

  it("refuse les identifiants de stratégie dupliqués", () => {
    const result = createStrategyRegistry([
      createEmaCrossStrategy({ id: "same", baseSize: 0.01 }),
      createEmaCrossStrategy({ id: "same", baseSize: 0.02 }),
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: "DUPLICATE_STRATEGY_ID", strategyId: "same" },
    });
  });
});

