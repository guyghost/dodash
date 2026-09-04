import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import { FUNDING_TREND_ENTER_THRESHOLD } from "@dodash/models";

import {
  createFundingTrendStrategy,
  FUNDING_TREND_STRATEGY_ID,
} from "../src/funding-trend.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid fixture product");

const snapshot = (overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot => ({
  snapshotId: "snapshot",
  candleClosedAt: 1_000,
  rsi: 50,
  emaFast: 101,
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

const context = (overrides: Record<string, unknown> = {}) => ({
  productId: productResult.value,
  candles: candles([100, 101, 102]),
  indicators: snapshot(),
  previousIndicators: null,
  ...overrides,
});

const strategy = () =>
  createFundingTrendStrategy({ enterThreshold: 5e-5, baseSize: 0.01 });

describe("funding-trend (models/funding-rate-strategy.md §5)", () => {
  it("renforce (BUY) : tendance haussière portée par un carry favorable", () => {
    const result = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -1e-4 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
    expect(result.ok && result.value.reasonCode).toBe("FUNDING_LONG_CARRY");
    expect(result.ok && result.value.suggestedSize).toBe(0.01);
  });

  it("réduit (SELL) : tendance baissière avec financement chargé contre les longs", () => {
    const result = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 99, emaSlow: 100, fundingAvg: 2e-4 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("SELL");
    expect(result.ok && result.value.reasonCode).toBe("FUNDING_SHORT_CROWDING");
  });

  it("amplitude sous le seuil ⇒ HOLD, même en tendance haussière", () => {
    const result = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -1e-5 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("FUNDING_NO_SIGNAL");
    expect(result.ok && result.value.suggestedSize).toBe(0);
  });

  it("prix et funding en désaccord ⇒ HOLD (jamais l'un sans l'autre)", () => {
    // carry favorable mais tendance baissière : pas de renforcement
    const bearish = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 99, emaSlow: 100, fundingAvg: -2e-4 }),
      }),
    );
    expect(bearish.ok && bearish.value.side).toBe("HOLD");
    // financement chargé mais tendance haussière : pas de réduction
    const bullish = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: 2e-4 }),
      }),
    );
    expect(bullish.ok && bullish.value.side).toBe("HOLD");
  });

  it("fundingAvg absent (échauffement) ⇒ HOLD FUNDING_WARMUP (INV-F3)", () => {
    const result = strategy().evaluate(context());
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("FUNDING_WARMUP");
    expect(result.ok && result.value.suggestedSize).toBe(0);
  });

  it("confidence croît avec l'amplitude et sature à 2× le seuil", () => {
    const atThreshold = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -5e-5 }),
      }),
    );
    expect(atThreshold.ok && atThreshold.value.confidence).toBe(0);
    const strong = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -1.5e-4 }),
      }),
    );
    expect(strong.ok && strong.value.confidence).toBe(1);
    const mid = strategy().evaluate(
      context({
        indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -7.5e-5 }),
      }),
    );
    expect(mid.ok && mid.value.confidence).toBeCloseTo(0.5, 12);
  });

  it("config invalide (seuil non positif) ⇒ INVALID_STRATEGY_CONFIG", () => {
    const result = createFundingTrendStrategy({
      enterThreshold: 0,
      baseSize: 0.01,
    }).evaluate(context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_STRATEGY_CONFIG");
      expect(result.error.strategyId).toBe(FUNDING_TREND_STRATEGY_ID);
    }
  });

  it("seuil absent ⇒ constante figée p75 (dao #38, INV-F9)", () => {
    const byDefault = createFundingTrendStrategy({ baseSize: 0.01 });
    // juste sous le seuil : amplitude négative ⇒ HOLD
    const under = byDefault.evaluate(
      context({
        indicators: snapshot({
          emaFast: 99,
          emaSlow: 100,
          fundingAvg: FUNDING_TREND_ENTER_THRESHOLD * (1 - 1e-9),
        }),
      }),
    );
    expect(under.ok && under.value.side).toBe("HOLD");
    expect(under.ok && under.value.reasonCode).toBe("FUNDING_NO_SIGNAL");
    // au seuil exact : autorisation shortCrowding ⇒ SELL, confiance nulle
    const atThreshold = byDefault.evaluate(
      context({
        indicators: snapshot({
          emaFast: 99,
          emaSlow: 100,
          fundingAvg: FUNDING_TREND_ENTER_THRESHOLD,
        }),
      }),
    );
    expect(atThreshold.ok && atThreshold.value.side).toBe("SELL");
    expect(atThreshold.ok && atThreshold.value.reasonCode).toBe(
      "FUNDING_SHORT_CROWDING",
    );
    expect(atThreshold.ok && atThreshold.value.confidence).toBe(0);
  });

  it("seuil explicite v1 (5e-5) reste honoré — rejeu campagne reproductible (C2)", () => {
    const v1 = createFundingTrendStrategy({
      enterThreshold: 5e-5,
      baseSize: 0.01,
    });
    // amplitude > seuil p75 mais < 5e-5 : HOLD en v1, SELL par défaut
    const mid = v1.evaluate(
      context({
        indicators: snapshot({
          emaFast: 99,
          emaSlow: 100,
          fundingAvg: 1e-5,
        }),
      }),
    );
    expect(mid.ok && mid.value.side).toBe("HOLD");
  });

  it("signaux déterministes : même entrée ⇒ même sortie", () => {
    const input = context({
      indicators: snapshot({ emaFast: 101, emaSlow: 100, fundingAvg: -1e-4 }),
    });
    const first = strategy().evaluate(input);
    const second = strategy().evaluate(input);
    expect(second).toEqual(first);
  });
});
