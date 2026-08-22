import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import type {
  RegimeConditionalSizingPolicy,
  RegimeFilterPolicy,
} from "@dodash/models";
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

// Confidence fractionnaire (≠ {0,1}) pour rendre le recalibrage
// observable dans les tailles allouées.
const strategyWithConfidence = (id: string, confidence: number): Strategy => ({
  id,
  evaluate: (context) => {
    const buy = context.candles.length === 3;
    const result = createSignal({
      strategyId: id,
      productId: context.productId,
      side: buy ? "BUY" : "HOLD",
      confidence: buy ? confidence : 0,
      suggestedSize: buy ? 1 : 0,
      reasonCode: buy ? "TEST_BUY" : "TEST_HOLD",
    });
    return result.ok
      ? result
      : {
          ok: false as const,
          error: {
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: id,
            cause: result.error,
          },
        };
  },
});

const registryWith = (
  entries: readonly (readonly [string, number])[],
): StrategyRegistry => {
  const registry = createStrategyRegistry(
    entries.map(([id, confidence]) => strategyWithConfidence(id, confidence)),
  );
  if (!registry.ok) throw new Error("invalid strategy fixture");
  return registry.value;
};

const preparedFor = (
  candles: readonly Candle[],
  tuning: { readonly emaFast: number; readonly emaSlow: number },
): PreparedBacktestIndicators => ({
  config: indicators,
  snapshots: candles.map((candle, index) =>
    index < 2
      ? null
      : {
          snapshotId: `snapshot-${index}`,
          candleClosedAt: candle.start,
          rsi: 50,
          emaFast: tuning.emaFast,
          emaSlow: tuning.emaSlow,
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

const baseCandles: Candle[] = [
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 180_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 240_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
];

const bullishPolicy: RegimeFilterPolicy = {
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 1,
  confirmationCount: 1,
} as const;

const identityPolicy: RegimeConditionalSizingPolicy = {
  bullish: "IDENTITY",
  bearish: "IDENTITY",
  range: "IDENTITY",
  warmUp: "IDENTITY",
};

const quarterBullPolicy: RegimeConditionalSizingPolicy = {
  ...identityPolicy,
  bullish: "POWER_QUARTER",
};

const quarterBearPolicy: RegimeConditionalSizingPolicy = {
  ...identityPolicy,
  bearish: "POWER_QUARTER",
};

const config = (
  strategies: StrategyRegistry,
  regimeFilter?: RegimeFilterPolicy,
  sizing?: RegimeConditionalSizingPolicy,
): BacktestConfig => ({
  runId: "regime-sizing-test",
  agentId: "regime-sizing-agent",
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
  ...(regimeFilter === undefined ? {} : { regimeFilter }),
  ...(sizing === undefined ? {} : { regimeConditionalSizing: sizing }),
});

describe("replayBacktest — sizing conditionné par régime", () => {
  it("INV-S1 : tous-bras IDENTITY ≡ absence de sizing (bit-identique)", async () => {
    const strategies = registryWith([["ema-cross", 0.5]]);
    const baseline = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    const identity = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy, identityPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!baseline.ok) throw new Error(JSON.stringify(baseline.error));
    if (!identity.ok) throw new Error(JSON.stringify(identity.error));
    expect(JSON.stringify(identity.value.trades)).toBe(
      JSON.stringify(baseline.value.trades),
    );
    expect(JSON.stringify(identity.value.finalPortfolio)).toBe(
      JSON.stringify(baseline.value.finalPortfolio),
    );
    expect(JSON.stringify(identity.value.equityCurve)).toBe(
      JSON.stringify(baseline.value.equityCurve),
    );
  });

  it("bras bullish agressif en régime BULLISH : la taille allouée augmente", async () => {
    const strategies = registryWith([["ema-cross", 0.5]]);
    const baseline = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    const sized = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy, quarterBullPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!baseline.ok) throw new Error(JSON.stringify(baseline.error));
    if (!sized.ok) throw new Error(JSON.stringify(sized.error));
    expect(sized.value.finalPortfolio.positionQuantity).toBeGreaterThan(
      baseline.value.finalPortfolio.positionQuantity,
    );
  });

  it("INV-S4 : stratégie non calibrable inchangée même bras agressif (BEARISH)", async () => {
    const strategies = registryWith([["rsi-reversion", 0.5]]);
    const baseline = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy),
      preparedFor(baseCandles, { emaFast: 1, emaSlow: 2 }),
    );
    const sized = await replayBacktest(
      baseCandles,
      config(strategies, bullishPolicy, quarterBearPolicy),
      preparedFor(baseCandles, { emaFast: 1, emaSlow: 2 }),
    );
    if (!baseline.ok) throw new Error(JSON.stringify(baseline.error));
    if (!sized.ok) throw new Error(JSON.stringify(sized.error));
    expect(JSON.stringify(sized.value.trades)).toBe(
      JSON.stringify(baseline.value.trades),
    );
    expect(JSON.stringify(sized.value.finalPortfolio)).toBe(
      JSON.stringify(baseline.value.finalPortfolio),
    );
  });

  it("INV-S2 : sizing sans regimeFilter rejeté (INVALID_BACKTEST_CONFIG)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith([["ema-cross", 0.5]]), undefined, quarterBullPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("INV-S2 : bras invalide rejeté (INVALID_BACKTEST_CONFIG)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith([["ema-cross", 0.5]]), bullishPolicy, {
        ...quarterBullPolicy,
        bullish: "NOT_A_PROFILE" as RegimeConditionalSizingPolicy["bullish"],
      }),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("warm-up (régime null) : signaux déniés, sizing inopérant", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(
        registryWith([["ema-cross", 0.5]]),
        { ...bullishPolicy, minObservations: 50 },
        quarterBullPolicy,
      ),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.trades).toHaveLength(0);
  });
});
