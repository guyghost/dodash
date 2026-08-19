import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import { createStrategyRegistry, type Strategy } from "@dodash/strategies";

import {
  replayBacktest,
  type BacktestConfig,
  type PreparedBacktestIndicators,
} from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const indicators = {
  rsiPeriod: 2,
  emaFastPeriod: 2,
  emaSlowPeriod: 3,
  atrPeriod: 2,
  historicalVolatilityPeriod: 2,
  momentumPeriod: 1,
  returnPeriods: [1],
  vwapPeriod: 2,
  relativeVolumePeriod: 1,
  volumeSpikeThreshold: 2,
  volumeTrendPeriod: 2,
  trendStrengthPeriod: 1,
} as const;

const buyOnce: Strategy = {
  id: "buy-once-multi-timeframe",
  evaluate: (context) => {
    const buy = context.candles.length === 3;
    const result = createSignal({
      strategyId: "buy-once-multi-timeframe",
      productId: context.productId,
      side: buy ? "BUY" : "HOLD",
      confidence: buy ? 1 : 0,
      suggestedSize: buy ? 1 : 0,
      reasonCode: buy ? "TEST_BUY" : "TEST_HOLD",
    });
    return result.ok
      ? result
      : {
          ok: false as const,
          error: {
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: "buy-once-multi-timeframe",
            cause: result.error,
          },
        };
  },
};

const registry = createStrategyRegistry([buyOnce]);
if (!registry.ok) throw new Error("invalid strategy fixture");

const config: BacktestConfig = {
  runId: "multi-timeframe-test",
  agentId: "multi-timeframe-agent",
  productId: product.value,
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  indicators,
  strategies: registry.value,
  risk: {
    maxOrderNotional: 5_000,
    maxPositionNotional: 10_000,
    maxGrossExposure: 10_000,
    maxDailyLoss: 5_000,
    cooldownMs: 0,
    stopLossBps: 100,
    takeProfitBps: 200,
  },
  broker: { feeBps: 0, slippageBps: 0 },
  protectiveExit: {
    mode: "FIXED_BPS",
    stopLossBps: 100,
    takeProfitBps: 200,
  },
};

const primaryCandles: readonly Candle[] = Object.freeze([
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 40 },
  { start: 240_000, open: 100, high: 101, low: 99, close: 100, volume: 40 },
  { start: 480_000, open: 100, high: 101, low: 99, close: 100, volume: 40 },
  { start: 720_000, open: 100, high: 103, low: 98, close: 100, volume: 40 },
  { start: 960_000, open: 100, high: 101, low: 99, close: 100, volume: 40 },
]);

const flatSubCandles = (primaryStart: number): readonly Candle[] => [
  { start: primaryStart, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  {
    start: primaryStart + 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  },
  {
    start: primaryStart + 120_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  },
  {
    start: primaryStart + 180_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  },
];

const executionCandles: readonly Candle[] = Object.freeze([
  ...flatSubCandles(0),
  ...flatSubCandles(240_000),
  ...flatSubCandles(480_000),
  { start: 720_000, open: 100, high: 101, low: 99.5, close: 100, volume: 10 },
  { start: 780_000, open: 100, high: 103, low: 100, close: 102, volume: 10 },
  { start: 840_000, open: 102, high: 102, low: 98, close: 99, volume: 10 },
  { start: 900_000, open: 99, high: 100, low: 99, close: 100, volume: 10 },
  ...flatSubCandles(960_000),
]);

const prepared: PreparedBacktestIndicators = {
  config: indicators,
  snapshots: primaryCandles.map((candle, index) =>
    index < 2
      ? null
      : {
          snapshotId: `snapshot-${index}`,
          candleClosedAt: candle.start,
          rsi: 50,
          emaFast: 2,
          emaSlow: 1,
          macd: 1,
          atr: 2,
          historicalVolatility: 0,
          momentum: 1,
          periodicReturns: { "1": 0 },
          ohlcvVwap: 100,
          tradeVwap: null,
          orderBookVwap: null,
          bidAskSpread: null,
          relativeVolume: 1,
          volumeSpike: false,
          volumeTrend: 0,
          vwapDeviation: 0,
          trendStrength: 20,
        },
  ),
};

describe("multi-timeframe protective replay", () => {
  it("résout l’ordre des seuils avec les sous-bougies", async () => {
    const daily = await replayBacktest(primaryCandles, config, prepared);
    const fine = await replayBacktest(primaryCandles, config, prepared, {
      executionCandles,
    });

    expect(daily.ok).toBe(true);
    expect(fine.ok).toBe(true);
    if (!daily.ok || !fine.ok) return;
    expect(daily.value.protectiveExits[0]).toMatchObject({
      kind: "STOP_LOSS",
      reason: "AMBIGUOUS_STOP_FIRST",
      referencePrice: 99,
      triggeredAt: 720_000,
    });
    expect(fine.value.protectiveExits[0]).toMatchObject({
      kind: "TAKE_PROFIT",
      reason: "INTRABAR",
      referencePrice: 102,
      triggeredAt: 780_000,
    });
  });

  it("préserve exactement le replay NONE avec une résolution fine valide", async () => {
    const noneConfig = { ...config, protectiveExit: { mode: "NONE" as const } };
    const daily = await replayBacktest(primaryCandles, noneConfig, prepared);
    const fine = await replayBacktest(primaryCandles, noneConfig, prepared, {
      executionCandles,
    });

    expect(fine).toEqual(daily);
  });

  it("refuse une série fine incomplète avant le replay", async () => {
    const result = await replayBacktest(primaryCandles, config, prepared, {
      executionCandles: executionCandles.slice(0, -1),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_EXECUTION_CANDLES",
        cause: { code: "MISALIGNED_EXECUTION_RANGE" },
      },
    });
  });
});
