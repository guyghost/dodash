import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";

import {
  createBreakoutStrategy,
  createRsiReversionStrategy,
  type StrategyContext,
} from "../src/index.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid fixture product");

const snapshot = (
  overrides: Partial<IndicatorSnapshot> = {},
): IndicatorSnapshot => ({
  snapshotId: "snapshot",
  candleClosedAt: 1_000,
  rsi: 50,
  emaFast: 100,
  emaSlow: 100,
  macd: 0,
  atr: 2,
  historicalVolatility: 0,
  momentum: 0,
  periodicReturns: { "1": 0 },
  ohlcvVwap: 100,
  tradeVwap: null,
  orderBookVwap: null,
  bidAskSpread: null,
  relativeVolume: 1,
  volumeSpike: false,
  volumeTrend: 0,
  vwapDeviation: 0,
  trendStrength: 0,
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

const makeContext = (
  overrides: Partial<StrategyContext> = {},
): StrategyContext => ({
  productId: productResult.value,
  candles: candles([100, 101, 102, 103]),
  indicators: snapshot(),
  previousIndicators: null,
  ...overrides,
});

describe("rsi-reversion — conditionnement (models/strategy-conditioning.md §3.2)", () => {
  it("INV-SC1 : sans nouvelles options, ignore positionSide et trendStrength élevé", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
    });
    const buy = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        confirmedRegime: "BEARISH",
        indicators: snapshot({ rsi: 20, trendStrength: 80 }),
      }),
    );
    expect(buy.ok && buy.value.side).toBe("BUY");
    expect(buy.ok && buy.value.reasonCode).toBe("RSI_OVERSOLD");

    const sell = strategy.evaluate(
      makeContext({
        positionSide: "FLAT",
        indicators: snapshot({ rsi: 80 }),
      }),
    );
    expect(sell.ok && sell.value.side).toBe("SELL");
    expect(sell.ok && sell.value.reasonCode).toBe("RSI_OVERBOUGHT");
  });

  it("INV-SC2 : maxTrendStrength invalide (<= 0 ou NaN) ⇒ INVALID_STRATEGY_CONFIG", () => {
    for (const maxTrendStrength of [0, -5, Number.NaN]) {
      const strategy = createRsiReversionStrategy({
        oversold: 30,
        overbought: 70,
        baseSize: 0.01,
        maxTrendStrength,
      });
      const result = strategy.evaluate(makeContext());
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_STRATEGY_CONFIG", strategyId: "rsi-reversion" },
      });
    }
  });

  it("maxTrendStrength : bloque BUY en RSI_TREND_BLOCKED si trendStrength > maxTrendStrength", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
      maxTrendStrength: 25,
    });
    const blocked = strategy.evaluate(
      makeContext({ indicators: snapshot({ rsi: 20, trendStrength: 25.1 }) }),
    );
    expect(blocked.ok && blocked.value.side).toBe("HOLD");
    expect(blocked.ok && blocked.value.reasonCode).toBe("RSI_TREND_BLOCKED");
    expect(blocked.ok && blocked.value.suggestedSize).toBe(0);
    expect(blocked.ok && blocked.value.confidence).toBe(0);

    const allowed = strategy.evaluate(
      makeContext({ indicators: snapshot({ rsi: 20, trendStrength: 25 }) }),
    );
    expect(allowed.ok && allowed.value.side).toBe("BUY");
    expect(allowed.ok && allowed.value.reasonCode).toBe("RSI_OVERSOLD");

    // SELL n'est pas bloqué par maxTrendStrength
    const sell = strategy.evaluate(
      makeContext({ indicators: snapshot({ rsi: 80, trendStrength: 50 }) }),
    );
    expect(sell.ok && sell.value.side).toBe("SELL");
  });

  it("positionAware : bloque BUY si LONG (RSI_ALREADY_LONG) et SELL si FLAT (RSI_NO_POSITION_TO_SELL)", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
      positionAware: true,
    });

    const alreadyLong = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        indicators: snapshot({ rsi: 20 }),
      }),
    );
    expect(alreadyLong.ok && alreadyLong.value.side).toBe("HOLD");
    expect(alreadyLong.ok && alreadyLong.value.reasonCode).toBe("RSI_ALREADY_LONG");
    expect(alreadyLong.ok && alreadyLong.value.suggestedSize).toBe(0);

    const flatSell = strategy.evaluate(
      makeContext({
        positionSide: "FLAT",
        indicators: snapshot({ rsi: 80 }),
      }),
    );
    expect(flatSell.ok && flatSell.value.side).toBe("HOLD");
    expect(flatSell.ok && flatSell.value.reasonCode).toBe("RSI_NO_POSITION_TO_SELL");
    expect(flatSell.ok && flatSell.value.suggestedSize).toBe(0);

    const shortSell = strategy.evaluate(
      makeContext({
        positionSide: "SHORT",
        indicators: snapshot({ rsi: 80 }),
      }),
    );
    expect(shortSell.ok && shortSell.value.side).toBe("HOLD");
    expect(shortSell.ok && shortSell.value.reasonCode).toBe("RSI_ALREADY_SHORT");

    const longSell = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        indicators: snapshot({ rsi: 80 }),
      }),
    );
    expect(longSell.ok && longSell.value.side).toBe("SELL");

    const flatBuy = strategy.evaluate(
      makeContext({
        positionSide: "FLAT",
        indicators: snapshot({ rsi: 20 }),
      }),
    );
    expect(flatBuy.ok && flatBuy.value.side).toBe("BUY");

    const undefinedSideBuy = strategy.evaluate(
      makeContext({ indicators: snapshot({ rsi: 20 }) }),
    );
    expect(undefinedSideBuy.ok && undefinedSideBuy.value.side).toBe("BUY");
  });

  it("INV-SC3 : priorité positionAware (RSI_ALREADY_LONG) avant maxTrendStrength (RSI_TREND_BLOCKED)", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
      positionAware: true,
      maxTrendStrength: 25,
    });
    const result = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        indicators: snapshot({ rsi: 20, trendStrength: 60 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("RSI_ALREADY_LONG");
  });
});

describe("breakout — conditionnement (models/strategy-conditioning.md §3.3)", () => {
  it("INV-SC1 : sans nouvelles options, ignore positionSide et relativeVolume", () => {
    const strategy = createBreakoutStrategy({ lookback: 3, baseSize: 0.01 });
    const buy = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        candles: candles([100, 101, 102, 110]),
        indicators: snapshot({ relativeVolume: null }),
      }),
    );
    expect(buy.ok && buy.value.side).toBe("BUY");
    expect(buy.ok && buy.value.reasonCode).toBe("BREAKOUT_UP");

    const sell = strategy.evaluate(
      makeContext({
        positionSide: "FLAT",
        candles: candles([100, 101, 102, 90]),
        indicators: snapshot({ relativeVolume: 0.1 }),
      }),
    );
    expect(sell.ok && sell.value.side).toBe("SELL");
    expect(sell.ok && sell.value.reasonCode).toBe("BREAKOUT_DOWN");
  });

  it("INV-SC2 : minRelativeVolume invalide (<= 0 ou NaN) ⇒ INVALID_STRATEGY_CONFIG", () => {
    for (const minRelativeVolume of [0, -1, Number.NaN]) {
      const strategy = createBreakoutStrategy({
        lookback: 3,
        baseSize: 0.01,
        minRelativeVolume,
      });
      const result = strategy.evaluate(
        makeContext({ candles: candles([100, 101, 102, 110]) }),
      );
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_STRATEGY_CONFIG", strategyId: "breakout" },
      });
    }
  });

  it("minRelativeVolume : exige relativeVolume non null >= seuil pour BUY/SELL, sinon BREAKOUT_LOW_VOLUME", () => {
    const strategy = createBreakoutStrategy({
      lookback: 3,
      baseSize: 0.01,
      minRelativeVolume: 1.5,
    });

    const nullVol = strategy.evaluate(
      makeContext({
        candles: candles([100, 101, 102, 110]),
        indicators: snapshot({ relativeVolume: null }),
      }),
    );
    expect(nullVol.ok && nullVol.value.side).toBe("HOLD");
    expect(nullVol.ok && nullVol.value.reasonCode).toBe("BREAKOUT_LOW_VOLUME");
    expect(nullVol.ok && nullVol.value.suggestedSize).toBe(0);

    const lowVol = strategy.evaluate(
      makeContext({
        candles: candles([100, 101, 102, 90]),
        indicators: snapshot({ relativeVolume: 1.49 }),
      }),
    );
    expect(lowVol.ok && lowVol.value.side).toBe("HOLD");
    expect(lowVol.ok && lowVol.value.reasonCode).toBe("BREAKOUT_LOW_VOLUME");

    const okVol = strategy.evaluate(
      makeContext({
        candles: candles([100, 101, 102, 110]),
        indicators: snapshot({ relativeVolume: 1.5 }),
      }),
    );
    expect(okVol.ok && okVol.value.side).toBe("BUY");
    expect(okVol.ok && okVol.value.reasonCode).toBe("BREAKOUT_UP");

    // Dans le range : reste BREAKOUT_INSIDE_RANGE même si volume faible
    const inside = strategy.evaluate(
      makeContext({
        candles: candles([100, 101, 102, 101]),
        indicators: snapshot({ relativeVolume: 0.2 }),
      }),
    );
    expect(inside.ok && inside.value.side).toBe("HOLD");
    expect(inside.ok && inside.value.reasonCode).toBe("BREAKOUT_INSIDE_RANGE");
  });

  it("positionAware : bloque BUY si LONG (BREAKOUT_ALREADY_LONG) et SELL si FLAT (BREAKOUT_NO_POSITION_TO_SELL)", () => {
    const strategy = createBreakoutStrategy({
      lookback: 3,
      baseSize: 0.01,
      positionAware: true,
      minRelativeVolume: 1.5,
    });

    const alreadyLong = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        candles: candles([100, 101, 102, 110]),
        indicators: snapshot({ relativeVolume: 0.5 }),
      }),
    );
    expect(alreadyLong.ok && alreadyLong.value.side).toBe("HOLD");
    expect(alreadyLong.ok && alreadyLong.value.reasonCode).toBe(
      "BREAKOUT_ALREADY_LONG",
    );

    const flatSell = strategy.evaluate(
      makeContext({
        positionSide: "FLAT",
        candles: candles([100, 101, 102, 90]),
        indicators: snapshot({ relativeVolume: 2.0 }),
      }),
    );
    expect(flatSell.ok && flatSell.value.side).toBe("HOLD");
    expect(flatSell.ok && flatSell.value.reasonCode).toBe(
      "BREAKOUT_NO_POSITION_TO_SELL",
    );

    const shortSell = strategy.evaluate(
      makeContext({
        positionSide: "SHORT",
        candles: candles([100, 101, 102, 90]),
        indicators: snapshot({ relativeVolume: 2.0 }),
      }),
    );
    expect(shortSell.ok && shortSell.value.side).toBe("HOLD");
    expect(shortSell.ok && shortSell.value.reasonCode).toBe(
      "BREAKOUT_ALREADY_SHORT",
    );

    const longSell = strategy.evaluate(
      makeContext({
        positionSide: "LONG",
        candles: candles([100, 101, 102, 90]),
        indicators: snapshot({ relativeVolume: 2.0 }),
      }),
    );
    expect(longSell.ok && longSell.value.side).toBe("SELL");
    expect(longSell.ok && longSell.value.reasonCode).toBe("BREAKOUT_DOWN");
  });
});
