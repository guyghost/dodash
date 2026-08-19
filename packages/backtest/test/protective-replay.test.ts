import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import {
  createStrategyRegistry,
  type Strategy,
  type StrategyRegistry,
} from "@dodash/strategies";

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
  id: "buy-once",
  evaluate: (context) => {
    const buy = context.candles.length === 3;
    const result = createSignal({
      strategyId: "buy-once",
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
            strategyId: "buy-once",
            cause: result.error,
          },
        };
  },
};

const registry = createStrategyRegistry([buyOnce]);
if (!registry.ok) throw new Error("invalid strategy fixture");

const preparedFor = (candles: readonly Candle[]): PreparedBacktestIndicators => ({
  config: indicators,
  snapshots: candles.map((candle, index) =>
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
});

const config = (strategies: StrategyRegistry): BacktestConfig => ({
  runId: "protective-test",
  agentId: "protective-agent",
  productId: product.value,
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  indicators,
  strategies,
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
});

const candlesWithTrigger = (
  trigger: { readonly open: number; readonly high: number; readonly low: number },
): Candle[] => [
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 180_000, ...trigger, close: 100, volume: 10 },
  { start: 240_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
];

describe("protective exits in replayBacktest", () => {
  it("conserve exactement le replay historique en mode NONE", async () => {
    const candles = candlesWithTrigger({ open: 100, high: 103, low: 98 });
    const legacy = await replayBacktest(
      candles,
      config(registry.value),
      preparedFor(candles),
    );
    const explicitNone = await replayBacktest(
      candles,
      { ...config(registry.value), protectiveExit: { mode: "NONE" } },
      preparedFor(candles),
    );

    expect(explicitNone).toEqual(legacy);
  });

  it("applique stop-first lorsque stop et objectif touchent la même bougie", async () => {
    const candles = candlesWithTrigger({ open: 100, high: 103, low: 98 });
    const result = await replayBacktest(
      candles,
      {
        ...config(registry.value),
        protectiveExit: {
          mode: "FIXED_BPS",
          stopLossBps: 100,
          takeProfitBps: 200,
        },
      },
      preparedFor(candles),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trades).toHaveLength(2);
    expect(result.value.trades[1]?.fill.price).toBe(99);
    expect(result.value.protectiveExits).toEqual([
      expect.objectContaining({
        kind: "STOP_LOSS",
        reason: "AMBIGUOUS_STOP_FIRST",
        referencePrice: 99,
      }),
    ]);
    expect(result.value.finalPortfolio.positionQuantity).toBe(0);
  });

  it("exécute un stop sur gap avant la plage intrabougie", async () => {
    const candles = candlesWithTrigger({ open: 100, high: 101, low: 99.5 });
    candles[4] = {
      start: 240_000,
      open: 95,
      high: 96,
      low: 94,
      close: 95,
      volume: 10,
    };
    const result = await replayBacktest(
      candles,
      {
        ...config(registry.value),
        protectiveExit: {
          mode: "FIXED_BPS",
          stopLossBps: 100,
          takeProfitBps: 200,
        },
      },
      preparedFor(candles),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protectiveExits[0]).toMatchObject({
      kind: "STOP_LOSS",
      reason: "GAP_OPEN",
      referencePrice: 95,
      triggeredAt: 240_000,
    });
    expect(result.value.trades[1]?.fill.price).toBe(95);
  });

  it("arme un stop ATR avec l’ATR connu à la décision précédente", async () => {
    const candles = candlesWithTrigger({ open: 100, high: 101, low: 97 });
    const result = await replayBacktest(
      candles,
      {
        ...config(registry.value),
        protectiveExit: {
          mode: "ATR_MULTIPLE",
          stopAtrMultiple: 1,
          takeAtrMultiple: 2,
        },
      },
      preparedFor(candles),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.protectiveExits[0]).toMatchObject({
      kind: "STOP_LOSS",
      reason: "INTRABAR",
      referencePrice: 98,
    });
  });
});
