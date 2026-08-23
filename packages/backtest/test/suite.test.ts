import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createStrategyRegistry } from "@dodash/strategies";

import * as backtest from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const linearQuantile = (values: readonly number[], probability: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) {
    throw new Error("empty quantile fixture");
  }
  return lower + (upper - lower) * (position - lowerIndex);
};

const suiteFixture = () => {
  const candles: Candle[] = Array.from({ length: 40 }, (_, index) => ({
    start: Date.UTC(2025, 0, 1 + index),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 10,
  }));
  const dataset: backtest.HistoricalDataset = {
    datasetId: "dataset-40-days",
    sha256: "a".repeat(64),
    source: "coinbase",
    endpoint: "https://api.coinbase.test/candles",
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt: candles[0]?.start ?? 0,
    endAt: (candles.at(-1)?.start ?? 0) + 86_400_000,
    candles,
  };
  const config: backtest.BacktestSuiteConfig = {
    runId: "suite-run",
    agentId: "backtest-agent",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: {
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
      maxGrossExposure: 10_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    },
    broker: { feeBps: 0, slippageBps: 0 },
  };
  return { dataset, config };
};

const executionDatasetFor = (
  dataset: backtest.HistoricalDataset,
): backtest.HistoricalDataset => {
  const candles: Candle[] = dataset.candles.flatMap((primary) => [
    {
      start: primary.start,
      open: primary.open,
      high: primary.open + 0.25,
      low: primary.open - 0.25,
      close: primary.open,
      volume: 2.5,
    },
    {
      start: primary.start + 21_600_000,
      open: primary.open,
      high: primary.high,
      low: primary.open,
      close: primary.open + 0.5,
      volume: 2.5,
    },
    {
      start: primary.start + 43_200_000,
      open: primary.open + 0.5,
      high: primary.open + 0.5,
      low: primary.low,
      close: primary.open - 0.5,
      volume: 2.5,
    },
    {
      start: primary.start + 64_800_000,
      open: primary.open - 0.5,
      high: primary.open,
      low: primary.open - 0.5,
      close: primary.close,
      volume: 2.5,
    },
  ]);
  return {
    datasetId: "dataset-160-six-hour-candles",
    sha256: "b".repeat(64),
    source: "coinbase",
    endpoint: dataset.endpoint,
    productId: dataset.productId,
    timeframe: "SIX_HOUR",
    startAt: dataset.startAt,
    endAt: dataset.endAt,
    candles,
  };
};

describe("backtest suite", () => {
  it("expose le runner comparatif", () => {
    expect(typeof (backtest as Record<string, unknown>).runBacktestSuite).toBe(
      "function",
    );
  });

  it("expose l’orchestration pilotée par la machine XState", () => {
    expect(
      typeof (backtest as Record<string, unknown>).runModeledBacktest,
    ).toBe("function");
  });

  it("expose le pré-calcul partagé des indicateurs", () => {
    expect(
      typeof (backtest as Record<string, unknown>).prepareBacktestIndicators,
    ).toBe("function");
  });

  it("pré-calcule un snapshot validé par bougie après le warmup", async () => {
    const candles: Candle[] = [100, 101, 102, 103, 104].map(
      (price, index) => ({
        start: index * 60_000,
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 10,
      }),
    );

    const result = await backtest.prepareBacktestIndicators(candles, {
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshots).toHaveLength(candles.length);
    expect(result.value.snapshots.slice(0, 2)).toEqual([null, null]);
    expect(result.value.snapshots.slice(2).map((snapshot) => snapshot?.candleClosedAt)).toEqual(
      candles.slice(2).map((candle) => candle.start),
    );
  });

  it("attend le warmup ADX complet avant de pré-calculer", async () => {
    const candles: Candle[] = Array.from({ length: 8 }, (_, index) => ({
      start: index * 60_000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 10,
    }));

    const result = await backtest.prepareBacktestIndicators(candles, {
      rsiPeriod: 2,
      emaFastPeriod: 1,
      emaSlowPeriod: 2,
      atrPeriod: 2,
      historicalVolatilityPeriod: 2,
      momentumPeriod: 1,
      returnPeriods: [1],
      vwapPeriod: 2,
      relativeVolumePeriod: 1,
      volumeSpikeThreshold: 2,
      volumeTrendPeriod: 2,
      trendStrengthPeriod: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshots.slice(0, 7)).toEqual(Array(7).fill(null));
    expect(result.value.snapshots[7]?.candleClosedAt).toBe(candles[7]?.start);
  });

  it("refuse un cache préparé avec une configuration étendue différente", async () => {
    const { dataset, config } = suiteFixture();
    const prepared = await backtest.prepareBacktestIndicators(
      dataset.candles,
      config.indicators,
    );
    const registry = createStrategyRegistry([]);
    if (!prepared.ok || !registry.ok) throw new Error("invalid prepared fixture");

    const result = await backtest.replayBacktest(
      dataset.candles,
      {
        ...config,
        productId: dataset.productId,
        indicators: {
          ...config.indicators,
          volumeSpikeThreshold: config.indicators.volumeSpikeThreshold + 1,
        },
        strategies: registry.value,
      },
      prepared.value,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_PREPARED_INDICATORS" },
    });
  });

  it("termine le workflow XState avec les artefacts du rapport", async () => {
    const { dataset, config } = suiteFixture();

    const result = await backtest.runModeledBacktest(dataset, config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workflow.state).toBe("completed");
    expect(result.value.workflow.context.datasetId).toBe(dataset.datasetId);
    expect(result.value.workflow.context.candleCount).toBe(dataset.candles.length);
    expect(result.value.workflow.context.processedCandles).toBe(dataset.candles.length);
    expect(result.value.workflow.context.metricsId).toBe(
      `${config.runId}:metrics`,
    );
    expect(result.value.workflow.context.executionDatasetId).toBeNull();
    expect(result.value.workflow.context.executionCandleCount).toBe(0);
    expect(result.value.report.executionDataset).toBeNull();
  });

  it("propage le dataset d’exécution dans le workflow et le rapport", async () => {
    const { dataset, config } = suiteFixture();
    const executionDataset = executionDatasetFor(dataset);

    const result = await backtest.runModeledBacktest(dataset, config, {
      executionDataset,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workflow.context.executionDatasetId).toBe(
      executionDataset.datasetId,
    );
    expect(result.value.workflow.context.executionCandleCount).toBe(
      executionDataset.candles.length,
    );
    expect(result.value.report.executionDataset).toMatchObject({
      datasetId: executionDataset.datasetId,
      sha256: executionDataset.sha256,
      timeframe: "SIX_HOUR",
      candleCount: executionDataset.candles.length,
    });
  });

  it("refuse un dataset d’exécution d’un autre produit", async () => {
    const { dataset, config } = suiteFixture();
    const executionDataset = executionDatasetFor(dataset);
    const otherProduct = createProductId("ETH-USD");
    if (!otherProduct.ok) throw new Error("invalid product fixture");

    const result = await backtest.runBacktestSuite(dataset, config, {
      executionDataset: { ...executionDataset, productId: otherProduct.value },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_EXECUTION_DATASET" },
    });
  });

  it("compare chaque stratégie, l’ensemble et le buy-and-hold déterministement", async () => {
    const { dataset, config } = suiteFixture();

    const first = await backtest.runBacktestSuite(dataset, config);
    const second = await backtest.runBacktestSuite(dataset, config);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;
    expect(first.value.benchmark.totalReturn).toBeCloseTo(0.39, 10);
    expect(first.value.scenarios.map((scenario) => scenario.id)).toEqual([
      "rsi-reversion",
      "ema-cross",
      "breakout",
      "ensemble",
    ]);
    expect(
      first.value.scenarios.every(
        (scenario) =>
          scenario.finalPortfolio.cash >= 0 &&
          scenario.finalPortfolio.positionQuantity >= 0,
      ),
    ).toBe(true);
    expect(first.value.scenarios.every((scenario) => Number.isFinite(scenario.excessReturn))).toBe(
      true,
    );
    expect(
      first.value.scenarios.every(
        (scenario) =>
          scenario.protectiveExitCount ===
            scenario.stopLossExitCount + scenario.takeProfitExitCount &&
          scenario.ambiguousExitCount <= scenario.stopLossExitCount,
      ),
    ).toBe(true);
    expect(first.value.config.targetSignalNotional).toBe(1_000);
    expect(
      first.value.scenarios.every(
        (scenario) =>
          scenario.diagnostics.signals.byStrategy.length ===
            scenario.strategyIds.length,
      ),
    ).toBe(true);
    expect(
      first.value.scenarios.find((scenario) => scenario.id === "ensemble")
        ?.diagnostics.signals.byStrategy.map(({ strategyId }) => strategyId),
    ).toEqual(["breakout", "ema-cross", "rsi-reversion"]);
    expect(
      first.value.scenarios.every(
        (scenario) => scenario.diagnosticSamples === null,
      ),
    ).toBe(true);
  });

  it("capture les échantillons diagnostiques uniquement sur demande", async () => {
    const { dataset, config } = suiteFixture();
    const result = await backtest.runBacktestSuite(dataset, config, {
      includeDiagnosticSamples: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const scenario of result.value.scenarios) {
      expect(scenario.diagnosticSamples).not.toBeNull();
      for (const strategy of scenario.diagnostics.signals.byStrategy) {
        const samples = scenario.diagnosticSamples?.requestedNotionalByStrategy.find(
          ({ strategyId }) => strategyId === strategy.strategyId,
        );
        expect(samples?.values).toHaveLength(strategy.activeSignalCount);
        if (samples === undefined || samples.values.length === 0) continue;
        expect(Math.min(...samples.values)).toBe(
          strategy.requestedNotional.min,
        );
        expect(Math.max(...samples.values)).toBe(
          strategy.requestedNotional.max,
        );
        expect(linearQuantile(samples.values, 0.5)).toBe(
          strategy.requestedNotional.median,
        );
        expect(linearQuantile(samples.values, 0.95)).toBe(
          strategy.requestedNotional.p95,
        );
      }
    }
  });

  it("calibre uniquement EMA et breakout sans créer de nouveaux signaux", async () => {
    const { dataset, config } = suiteFixture();
    const identity = await backtest.runBacktestSuite(dataset, config);
    const calibrated = await backtest.runBacktestSuite(dataset, {
      ...config,
      confidenceCalibration: "POWER_THIRD",
    });

    expect(identity.ok).toBe(true);
    expect(calibrated.ok).toBe(true);
    if (!identity.ok || !calibrated.ok) return;

    const identityRsi = identity.value.scenarios.find(
      ({ id }) => id === "rsi-reversion",
    );
    const calibratedRsi = calibrated.value.scenarios.find(
      ({ id }) => id === "rsi-reversion",
    );
    expect(calibratedRsi).toEqual(identityRsi);

    for (const scenarioId of ["ema-cross", "breakout"] as const) {
      const raw = identity.value.scenarios.find(({ id }) => id === scenarioId);
      const transformed = calibrated.value.scenarios.find(
        ({ id }) => id === scenarioId,
      );
      expect(raw).toBeDefined();
      expect(transformed).toBeDefined();
      if (raw === undefined || transformed === undefined) continue;
      const rawSignals = raw.diagnostics.signals.byStrategy[0];
      const transformedSignals = transformed.diagnostics.signals.byStrategy[0];
      expect(transformedSignals?.activeSignalCount).toBe(
        rawSignals?.activeSignalCount,
      );
      expect(transformedSignals?.buySignalCount).toBe(
        rawSignals?.buySignalCount,
      );
      expect(transformedSignals?.sellSignalCount).toBe(
        rawSignals?.sellSignalCount,
      );
      if ((rawSignals?.activeSignalCount ?? 0) > 0) {
        expect(
          transformedSignals?.requestedNotional.median,
        ).toBeGreaterThanOrEqual(
          rawSignals?.requestedNotional.median ?? Number.POSITIVE_INFINITY,
        );
      }
    }
  });

  it("refuse un notionnel cible invalide", async () => {
    const { dataset, config } = suiteFixture();

    const result = await backtest.runBacktestSuite(dataset, {
      ...config,
      targetSignalNotional: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_SUITE_CONFIG" },
    });
  });

  it("refuse un profil de calibration inconnu", async () => {
    const { dataset, config } = suiteFixture();
    const result = await backtest.runBacktestSuite(dataset, {
      ...config,
      confidenceCalibration: "POWER_FIFTH",
    } as unknown as backtest.BacktestSuiteConfig);

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_SUITE_CONFIG" },
    });
  });

  it("refuse une politique de filtre de régime invalide", async () => {
    const { dataset, config } = suiteFixture();
    const result = await backtest.runBacktestSuite(dataset, {
      ...config,
      regimeFilter: {
        mode: "EMA_THRESHOLD",
        thresholdBps: 0,
        minObservations: 5,
        confirmationCount: 2,
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_SUITE_CONFIG" },
    });
  });

  it("refuse un exit REGIME_CONDITIONAL sans filtre de régime", async () => {
    const { dataset, config } = suiteFixture();
    const noneArm = { mode: "NONE" } as const;
    const result = await backtest.runBacktestSuite(dataset, {
      ...config,
      protectiveExit: {
        mode: "REGIME_CONDITIONAL",
        bullish: noneArm,
        bearish: noneArm,
        range: noneArm,
        warmUp: noneArm,
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_SUITE_CONFIG" },
    });
  });
});
