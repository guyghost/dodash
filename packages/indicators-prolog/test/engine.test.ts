import { describe, expect, it } from "vitest";

import type { Candle } from "@dodash/domain";

import { computeIndicators } from "../src/index.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 10,
  }));

const config = {
  rsiPeriod: 5,
  emaFastPeriod: 3,
  emaSlowPeriod: 5,
  atrPeriod: 3,
  historicalVolatilityPeriod: 3,
  momentumPeriod: 2,
  returnPeriods: [1, 2],
  vwapPeriod: 3,
  relativeVolumePeriod: 2,
  volumeSpikeThreshold: 2,
  volumeTrendPeriod: 3,
  trendStrengthPeriod: 2,
} as const;

const compactConfig = {
  ...config,
  rsiPeriod: 2,
  emaFastPeriod: 1,
  emaSlowPeriod: 2,
  atrPeriod: 3,
  historicalVolatilityPeriod: 2,
  momentumPeriod: 1,
  returnPeriods: [1],
  vwapPeriod: 2,
  relativeVolumePeriod: 1,
  volumeTrendPeriod: 2,
  trendStrengthPeriod: 2,
} as const;

describe("computeIndicators", () => {
  it("calcule les indicateurs avec Tau-Prolog", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15, 16, 17]),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rsi).toBe(100);
    expect(result.value.emaFast).toBeGreaterThan(result.value.emaSlow);
    expect(result.value.macd).toBeCloseTo(
      result.value.emaFast - result.value.emaSlow,
      10,
    );
    expect(result.value.atr).toBeCloseTo(2, 10);
    expect(result.value.trendStrength).toBeCloseTo(100, 10);
  });

  it("lisse l'ATR avec la formule de Wilder après la fenêtre initiale", async () => {
    const ranges = [1, 2, 4, 8];
    const candles = ranges.map((range, index) => ({
      start: index * 60_000,
      open: 100,
      high: 100 + range / 2,
      low: 100 - range / 2,
      close: 100,
      volume: 10,
    }));

    const result = await computeIndicators(candles, compactConfig);

    expect(result.ok && result.value.atr).toBeCloseTo(38 / 9, 10);
  });

  it("calcule volatilité des log-rendements, momentum et rendements périodiques", async () => {
    const result = await computeIndicators(
      candlesFromCloses([100, 100, 100, 110, 99, 108.9]),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.historicalVolatility).toBeCloseTo(0.11585728004354243, 12);
    expect(result.value.momentum).toBeCloseTo(-1.1, 12);
    expect(result.value.periodicReturns).toEqual({
      "1": expect.closeTo(0.1, 12),
      "2": expect.closeTo(-0.01, 12),
    });
  });

  it("calcule VWAP OHLCV, RVOL, pic, tendance de volume et déviation", async () => {
    const candles: Candle[] = [
      { start: 0, open: 5, high: 6, low: 4, close: 5, volume: 5 },
      { start: 60_000, open: 10, high: 12, low: 8, close: 10, volume: 10 },
      { start: 120_000, open: 20, high: 22, low: 18, close: 20, volume: 20 },
      { start: 180_000, open: 30, high: 32, low: 28, close: 30, volume: 60 },
    ];
    const result = await computeIndicators(candles, {
      ...compactConfig,
      vwapPeriod: 3,
      relativeVolumePeriod: 2,
      volumeTrendPeriod: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ohlcvVwap).toBeCloseTo(2300 / 90, 12);
    expect(result.value.relativeVolume).toBeCloseTo(4, 12);
    expect(result.value.volumeSpike).toBe(true);
    expect(result.value.volumeTrend).toBeCloseTo(5 / 6, 12);
    expect(result.value.vwapDeviation).toBeCloseTo(4 / 23, 12);
  });

  it("retourne null quand les volumes ne définissent pas un ratio", async () => {
    const candles = candlesFromCloses([10, 10, 10, 10]).map((candle) => ({
      ...candle,
      volume: 0,
    }));

    const result = await computeIndicators(candles, compactConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ohlcvVwap).toBeNull();
    expect(result.value.relativeVolume).toBeNull();
    expect(result.value.volumeSpike).toBeNull();
    expect(result.value.volumeTrend).toBeNull();
    expect(result.value.vwapDeviation).toBeNull();
  });

  it("sépare le VWAP des transactions du VWAP du carnet et du spread", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15]),
      config,
      {
        trades: [
          { price: 100, size: 2 },
          { price: 110, size: 1 },
        ],
        orderBook: {
          bids: [
            { price: 99, size: 2 },
            { price: 98, size: 1 },
          ],
          asks: [
            { price: 101, size: 1 },
            { price: 102, size: 3 },
          ],
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tradeVwap).toBeCloseTo(310 / 3, 12);
    expect(result.value.orderBookVwap).toEqual({
      bid: expect.closeTo(296 / 3, 12),
      ask: expect.closeTo(407 / 4, 12),
      mid: expect.closeTo((296 / 3 + 407 / 4) / 2, 12),
    });
    expect(result.value.bidAskSpread).toEqual({
      absolute: 2,
      bps: 200,
    });
  });

  it("ne fabrique pas de microstructure quand elle est absente", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15]),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tradeVwap).toBeNull();
    expect(result.value.orderBookVwap).toBeNull();
    expect(result.value.bidAskSpread).toBeNull();
  });

  it("refuse un carnet croisé", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15]),
      config,
      {
        orderBook: {
          bids: [{ price: 102, size: 1 }],
          asks: [{ price: 101, size: 1 }],
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_MICROSTRUCTURE" },
    });
  });

  it("refuse des horizons de rendement dupliqués", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15]),
      { ...config, returnPeriods: [1, 1] },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_CONFIG" },
    });
  });

  it("retourne RSI 50 pour un marché plat", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 10, 10, 10, 10, 10]),
      config,
    );
    expect(result.ok && result.value.rsi).toBe(50);
    expect(result.ok && result.value.trendStrength).toBe(0);
  });

  it("retourne RSI 0 sans aucun gain", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 9, 8, 7, 6, 5]),
      config,
    );
    expect(result.ok && result.value.rsi).toBe(0);
  });

  it("refuse un historique trop court", async () => {
    const result = await computeIndicators(candlesFromCloses([10, 11]), config);
    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CANDLES", required: 6, actual: 2 },
    });
  });

  it("produit un identifiant déterministe", async () => {
    const candles = candlesFromCloses([10, 11, 12, 13, 14, 15]);
    const first = await computeIndicators(candles, config);
    const second = await computeIndicators(candles, config);
    const withTrades = await computeIndicators(candles, config, {
      trades: [{ price: 15, size: 1 }],
    });
    expect(first.ok && second.ok && first.value.snapshotId).toBe(
      second.ok ? second.value.snapshotId : "",
    );
    expect(first.ok && withTrades.ok && first.value.snapshotId).not.toBe(
      withTrades.ok ? withTrades.value.snapshotId : "",
    );
  });
});
