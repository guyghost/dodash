import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import type { RegimePermissions } from "@dodash/models";
import {
  createFundingTrendStrategy,
  createStrategyRegistry,
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

const baseCandles: Candle[] = [
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 180_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 240_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
];

// BUY unique à la 3e bougie de décision (index 2) ⇒ remplissage à l'open
// de l'index 3 (position 1 tenue aux clôtures des index 3 et 4).
const buyOnceRegistry = (): BacktestConfig["strategies"] => {
  const registry = createStrategyRegistry([
    {
      id: "test-buy-once",
      evaluate: (context) => {
        const buy = context.candles.length === 3;
        const result = createSignal({
          strategyId: "test-buy-once",
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
                strategyId: "test-buy-once",
                cause: result.error,
              },
            };
      },
    },
  ]);
  if (!registry.ok) throw new Error("invalid strategy fixture");
  return registry.value;
};

const prepared = (
  candles: readonly Candle[],
  overrides: Partial<{ fundingAvg: number }> = {},
): PreparedBacktestIndicators => ({
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
          ...overrides,
        },
  ),
});

const config = (
  strategies: BacktestConfig["strategies"],
  fundingRates?: readonly number[],
): BacktestConfig => ({
  runId: "funding-replay-test",
  agentId: "funding-replay-agent",
  productId: product.value,
  intervalMs: 60_000,
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
  ...(fundingRates === undefined ? {} : { fundingRates }),
});

const run = async (
  strategies: BacktestConfig["strategies"],
  fundingRates?: readonly number[],
) => {
  const result = await replayBacktest(
    baseCandles,
    config(strategies, fundingRates),
    prepared(baseCandles),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe("replayBacktest — coût de funding (models/funding-rate-strategy.md §6)", () => {
  it("sans série de funding : replay bit-identique et fundingPaid nul (INV-F1/F7)", async () => {
    const baseline = await run(buyOnceRegistry());
    const zeroed = await run(buyOnceRegistry(), [0, 0, 0, 0, 0]);
    expect(baseline.fundingPaid).toBe(0);
    expect(zeroed.fundingPaid).toBe(0);
    expect(zeroed.metrics).toEqual(baseline.metrics);
    expect(zeroed.equityCurve).toEqual(baseline.equityCurve);
    expect(zeroed.finalPortfolio).toEqual(baseline.finalPortfolio);
  });

  it("le PnL reflète exactement le coût de funding en position (INV-F7)", async () => {
    // position 1 aux clôtures des index 3 et 4 :
    // coût(3) = 1 × 100 × 0,001 = +0,1 ; coût(4) = 1 × 100 × (−0,002) = −0,2
    const withFunding = await run(buyOnceRegistry(), [0, 0, 0, 0.001, -0.002]);
    const baseline = await run(buyOnceRegistry());
    expect(withFunding.fundingPaid).toBeCloseTo(-0.1, 12);
    expect(withFunding.metrics.pnl - baseline.metrics.pnl).toBeCloseTo(0.1, 12);
    // le cash final porte les coûts, pas la valorisation
    expect(withFunding.finalPortfolio.cash - baseline.finalPortfolio.cash)
      .toBeCloseTo(0.1, 12);
  });

  it("aucun coût sans position ouverte (avant remplissage)", async () => {
    // coûts non nuls dès l'index 0 : sans position, ils ne touchent rien
    const result = await run(buyOnceRegistry(), [0.01, 0.01, 0.01, 0, 0]);
    const baseline = await run(buyOnceRegistry());
    expect(result.fundingPaid).toBe(0);
    expect(result.metrics).toEqual(baseline.metrics);
  });

  it("série de longueur ≠ bougies ⇒ INVALID_BACKTEST_CONFIG (INV-F2)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(buyOnceRegistry(), [0.001, 0.001]),
      prepared(baseCandles),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("taux non fini ⇒ INVALID_BACKTEST_CONFIG (INV-F2)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(buyOnceRegistry(), [0, 0, Number.NaN, 0, 0]),
      prepared(baseCandles),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });
});

describe("replayBacktest — inactivité de funding-trend (C3, INV-F5)", () => {
  const fundingStrategyRegistry = () => {
    const registry = createStrategyRegistry([
      createFundingTrendStrategy({ enterThreshold: 5e-5, baseSize: 1 }),
    ]);
    if (!registry.ok) throw new Error("invalid strategy fixture");
    return registry.value;
  };

  const preparedFunding = (): PreparedBacktestIndicators =>
    prepared(baseCandles, { fundingAvg: -1e-4 });

  const bullish = {
    mode: "EMA_THRESHOLD",
    thresholdBps: 100,
    minObservations: 1,
    confirmationCount: 1,
  } as const;

  it("absente de la table par défaut ⇒ déni partout, zéro trade", async () => {
    const result = await replayBacktest(
      baseCandles,
      { ...config(fundingStrategyRegistry()), regimeFilter: bullish },
      preparedFunding(),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.trades).toHaveLength(0);
    expect(result.value.regimeGating?.deniedByStrategy["funding-trend"]).toBe(3);
  });

  it("permise explicitement ⇒ signaux passés et coûts de funding appliqués", async () => {
    const permissions: RegimePermissions = {
      BULLISH: ["funding-trend"],
      BEARISH: [],
      RANGE: [],
    };
    const result = await replayBacktest(
      baseCandles,
      {
        ...config(fundingStrategyRegistry(), [0, 0, 0, 0.001, -0.002]),
        regimeFilter: bullish,
        regimePermissions: permissions,
      },
      preparedFunding(),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.value.regimeGating?.deniedByStrategy["funding-trend"] ?? 0).toBe(0);
    // BUY émis à chaque décision ⇒ position tenue ⇒ coûts non nuls
    expect(result.value.fundingPaid).not.toBe(0);
  });
});

describe("replayBacktest — indicateur funding au chemin non préparé (§6)", () => {
  // 80 bougies en croissance régulière (~3 %/bougie) : emaFast > emaSlow
  // avec un écart > 100 bps (indicateurs compacts ema 2/3).
  const risingCandles: Candle[] = Array.from({ length: 80 }, (_, index) => {
    const close = 10 * 1.03 ** index;
    return {
      start: index * 60_000,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 10,
    };
  });
  const negativeRates = Array.from({ length: 80 }, () => -1e-4);
  const positiveRates = Array.from({ length: 80 }, () => 1e-4);
  const permissions: RegimePermissions = {
    BULLISH: ["funding-trend"],
    BEARISH: [],
    RANGE: [],
  };
  const bullish = {
    mode: "EMA_THRESHOLD",
    thresholdBps: 100,
    minObservations: 1,
    confirmationCount: 1,
  } as const;

  const fundingRegistry = () => {
    const registry = createStrategyRegistry([
      createFundingTrendStrategy({ enterThreshold: 5e-5, baseSize: 1 }),
    ]);
    if (!registry.ok) throw new Error("invalid strategy fixture");
    return registry.value;
  };

  const runRising = async (fundingRates?: readonly number[]) => {
    const result = await replayBacktest(
      risingCandles,
      {
        ...config(fundingRegistry(), fundingRates),
        regimeFilter: bullish,
        regimePermissions: permissions,
      },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  };

  it("carry favorable + tendance haussière ⇒ signaux exécutés", { timeout: 30_000 }, async () => {
    const result = await runRising(negativeRates);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.fundingPaid).not.toBe(0);
  });

  it("sans série ⇒ fundingAvg absent ⇒ HOLD partout (INV-F3)", { timeout: 30_000 }, async () => {
    const result = await runRising();
    expect(result.trades).toHaveLength(0);
  });

  it("carry défavorable (funding positif) ⇒ HOLD malgré la tendance", { timeout: 30_000 }, async () => {
    const result = await runRising(positiveRates);
    expect(result.trades).toHaveLength(0);
  });
});
