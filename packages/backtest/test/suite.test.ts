import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";

import * as backtest from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

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
    baseSize: 0.01,
    indicators: {
      rsiPeriod: 14,
      emaFastPeriod: 12,
      emaSlowPeriod: 26,
      atrPeriod: 14,
    },
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshots).toHaveLength(candles.length);
    expect(result.value.snapshots.slice(0, 2)).toEqual([null, null]);
    expect(result.value.snapshots.slice(2).map((snapshot) => snapshot?.candleClosedAt)).toEqual(
      candles.slice(2).map((candle) => candle.start),
    );
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
  });
});
