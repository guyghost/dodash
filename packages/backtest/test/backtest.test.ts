import { describe, expect, it } from "vitest";

import {
  createOrderIntent,
  createProductId,
  createSignal,
  type Candle,
  type OrderIntent,
} from "@dodash/domain";
import {
  createStrategyRegistry,
  type Strategy,
  type StrategyRegistry,
} from "@dodash/strategies";

import {
  calculateMetrics,
  executePaperOrder,
  replayBacktest,
  type PaperPortfolio,
  type PreparedBacktestIndicators,
} from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const testIndicatorConfig = {
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

const order = (side: "BUY" | "SELL", quantity = 1): OrderIntent => {
  const result = createOrderIntent({
    clientOrderId: `${side}-${quantity}`,
    decisionId: "decision",
    strategyIds: ["test"],
    productId: product.value,
    side,
    type: "MARKET",
    quantity,
    limitPrice: null,
  });
  if (!result.ok) throw new Error("invalid order fixture");
  return result.value;
};

describe("paper broker", () => {
  it("réalise le PnL d’un aller-retour", () => {
    const initial: PaperPortfolio = { cash: 1_000, positionQuantity: 0, averagePrice: 0 };
    const buy = executePaperOrder(initial, order("BUY"), 100, 1, {
      feeBps: 0,
      slippageBps: 0,
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    const sell = executePaperOrder(buy.value.portfolio, order("SELL"), 110, 2, {
      feeBps: 0,
      slippageBps: 0,
    });
    expect(sell.ok && sell.value.trade.realizedPnl).toBe(10);
    expect(sell.ok && sell.value.portfolio.cash).toBe(1_010);
  });

  it("refuse une vente spot sans position détenue", () => {
    const result = executePaperOrder(
      { cash: 1_000, positionQuantity: 0, averagePrice: 0 },
      order("SELL"),
      100,
      1,
      { feeBps: 0, slippageBps: 0 },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_POSITION" },
    });
  });

  it("refuse un achat dont le coût frais inclus dépasse le cash", () => {
    const result = executePaperOrder(
      { cash: 100, positionQuantity: 0, averagePrice: 0 },
      order("BUY"),
      100,
      1,
      { feeBps: 6, slippageBps: 0 },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CASH" },
    });
  });

  it("accepte un achat all-in malgré l’arrondi flottant et conserve un cash nul", () => {
    const marketPrice = 117_488.59;
    const feeBps = 6;
    const slippageBps = 2;
    const executionPrice = marketPrice * (1 + slippageBps / 10_000);
    const quantity = 10_000 / (executionPrice * (1 + feeBps / 10_000));

    const result = executePaperOrder(
      { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
      order("BUY", quantity),
      marketPrice,
      1,
      { feeBps, slippageBps },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.portfolio.cash).toBe(0);
    expect(result.value.portfolio.positionQuantity).toBe(quantity);
  });

  it("intègre les frais d’entrée au prix de revient et réalise le PnL à la clôture", () => {
    const initial: PaperPortfolio = {
      cash: 1_000,
      positionQuantity: 0,
      averagePrice: 0,
    };
    const buy = executePaperOrder(initial, order("BUY"), 100, 1, {
      feeBps: 100,
      slippageBps: 0,
    });
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    expect(buy.value.trade.realizedPnl).toBe(0);
    expect(buy.value.trade.closedQuantity).toBe(0);
    expect(buy.value.portfolio.averagePrice).toBe(101);

    const sell = executePaperOrder(buy.value.portfolio, order("SELL"), 110, 2, {
      feeBps: 100,
      slippageBps: 0,
    });
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    expect(sell.value.trade.closedQuantity).toBe(1);
    expect(sell.value.trade.realizedPnl).toBeCloseTo(7.9, 10);
    expect(sell.value.portfolio.cash).toBeCloseTo(1_007.9, 10);

    const metrics = calculateMetrics(
      [
        { at: 1, equity: 999 },
        { at: 2, equity: 1_007.9 },
      ],
      [buy.value.trade, sell.value.trade],
      1_000,
    );
    expect(metrics.winRate).toBe(1);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.fees).toBeCloseTo(2.1, 10);
    expect(metrics.realizedPnl).toBeCloseTo(7.9, 10);
    expect(metrics.unrealizedPnl).toBeCloseTo(0, 10);
    expect(metrics.realizedPnl + metrics.unrealizedPnl).toBeCloseTo(
      metrics.pnl,
      10,
    );
  });
});

describe("metrics", () => {
  it("calcule PnL, return et drawdown", () => {
    const metrics = calculateMetrics(
      [
        { at: 1, equity: 100 },
        { at: 2, equity: 120 },
        { at: 3, equity: 90 },
        { at: 4, equity: 110 },
      ],
      [],
      100,
    );
    expect(metrics.pnl).toBe(10);
    expect(metrics.totalReturn).toBeCloseTo(0.1, 10);
    expect(metrics.maxDrawdown).toBeCloseTo(0.25, 10);
    expect(metrics.profitFactor).toBeNull();
  });
});

describe("replayBacktest", () => {
  it("rejoue le même cœur et produit des métriques", async () => {
    const flip: Strategy = {
      id: "flip",
      evaluate: (context) => {
        const index = context.candles.length;
        const result = createSignal({
          strategyId: "flip",
          productId: context.productId,
          side: index % 2 === 0 ? "SELL" : "BUY",
          confidence: 1,
          suggestedSize: 0.1,
          reasonCode: "TEST_FLIP",
        });
        return result.ok
          ? result
          : {
              ok: false as const,
              error: {
                code: "INVALID_STRATEGY_SIGNAL" as const,
                strategyId: "flip",
                cause: result.error,
              },
            };
      },
    };
    const registry = createStrategyRegistry([flip]);
    if (!registry.ok) throw new Error("invalid registry fixture");
    const candles: Candle[] = [100, 101, 102, 103, 104, 105, 106].map(
      (close, index) => ({
        start: index * 60_000,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 10,
      }),
    );

    const result = await replayBacktest(candles, {
      runId: "run-1",
      agentId: "agent-1",
      productId: product.value,
      initialCapital: 10_000,
      maxDecisionNotional: 5_000,
      minNetQuantity: 0.0001,
      indicators: testIndicatorConfig,
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processedCandles).toBe(candles.length);
    expect(result.value.trades.length).toBeGreaterThan(0);
    expect(result.value.equityCurve).toHaveLength(candles.length);
    expect(Number.isFinite(result.value.metrics.pnl)).toBe(true);
  });

  it("exécute une décision uniquement à l’ouverture de la bougie suivante", async () => {
    const nextOpen: Strategy = {
      id: "next-open",
      evaluate: (context) => {
        const result = createSignal({
          strategyId: "next-open",
          productId: context.productId,
          side: context.candles.length === 3 ? "BUY" : "HOLD",
          confidence: context.candles.length === 3 ? 1 : 0,
          suggestedSize: context.candles.length === 3 ? 0.1 : 0,
          reasonCode: "TEST_NEXT_OPEN",
        });
        return result.ok
          ? result
          : {
              ok: false as const,
              error: {
                code: "INVALID_STRATEGY_SIGNAL" as const,
                strategyId: "next-open",
                cause: result.error,
              },
            };
      },
    };
    const registry = createStrategyRegistry([nextOpen]);
    if (!registry.ok) throw new Error("invalid registry fixture");
    const candles: Candle[] = [100, 101, 102, 110, 111].map(
      (open, index) => ({
        start: index * 60_000,
        open,
        high: open + 2,
        low: open - 2,
        close: open + 1,
        volume: 10,
      }),
    );

    const result = await replayBacktest(candles, {
      ...backtestConfig(registry.value),
      runId: "next-open-run",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trades).toHaveLength(1);
    expect(result.value.trades[0]?.fill.executedAt).toBe(candles[3]?.start);
    expect(result.value.trades[0]?.fill.price).toBe(candles[3]?.open);
  });

  it("n’exécute pas une décision produite sur la dernière bougie", async () => {
    const lastCandle: Strategy = {
      id: "last-candle",
      evaluate: (context) => {
        const shouldBuy = context.candles.length === 5;
        const result = createSignal({
          strategyId: "last-candle",
          productId: context.productId,
          side: shouldBuy ? "BUY" : "HOLD",
          confidence: shouldBuy ? 1 : 0,
          suggestedSize: shouldBuy ? 0.1 : 0,
          reasonCode: "TEST_LAST_CANDLE",
        });
        return result.ok
          ? result
          : {
              ok: false as const,
              error: {
                code: "INVALID_STRATEGY_SIGNAL" as const,
                strategyId: "last-candle",
                cause: result.error,
              },
            };
      },
    };
    const registry = createStrategyRegistry([lastCandle]);
    if (!registry.ok) throw new Error("invalid registry fixture");
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

    const result = await replayBacktest(candles, {
      ...backtestConfig(registry.value),
      runId: "last-candle-run",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trades).toHaveLength(0);
  });

  it("ignore une vente spot lorsque le portefeuille ne détient rien", async () => {
    const sellOnly: Strategy = {
      id: "sell-only",
      evaluate: (context) => {
        const result = createSignal({
          strategyId: "sell-only",
          productId: context.productId,
          side: "SELL",
          confidence: 1,
          suggestedSize: 0.1,
          reasonCode: "TEST_SELL_ONLY",
        });
        return result.ok
          ? result
          : {
              ok: false as const,
              error: {
                code: "INVALID_STRATEGY_SIGNAL" as const,
                strategyId: "sell-only",
                cause: result.error,
              },
            };
      },
    };
    const registry = createStrategyRegistry([sellOnly]);
    if (!registry.ok) throw new Error("invalid registry fixture");
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

    const result = await replayBacktest(candles, {
      ...backtestConfig(registry.value),
      runId: "spot-long-only-run",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trades).toHaveLength(0);
    expect(result.value.finalPortfolio.positionQuantity).toBe(0);
    expect(result.value.finalPortfolio.cash).toBe(10_000);
  });

  it("réutilise les indicateurs préparés au lieu de les recalculer par scénario", async () => {
    const cachedSignal: Strategy = {
      id: "cached-signal",
      evaluate: (context) => {
        const shouldBuy = context.indicators.rsi === 10;
        const result = createSignal({
          strategyId: "cached-signal",
          productId: context.productId,
          side: shouldBuy ? "BUY" : "HOLD",
          confidence: shouldBuy ? 1 : 0,
          suggestedSize: shouldBuy ? 0.1 : 0,
          reasonCode: "TEST_PREPARED_INDICATORS",
        });
        return result.ok
          ? result
          : {
              ok: false as const,
              error: {
                code: "INVALID_STRATEGY_SIGNAL" as const,
                strategyId: "cached-signal",
                cause: result.error,
              },
            };
      },
    };
    const registry = createStrategyRegistry([cachedSignal]);
    if (!registry.ok) throw new Error("invalid registry fixture");
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
    const indicatorConfig = testIndicatorConfig;
    const prepared: PreparedBacktestIndicators = {
      config: indicatorConfig,
      snapshots: candles.map((candle, index) =>
        index < 2
          ? null
          : {
              snapshotId: `prepared-${index}`,
              candleClosedAt: candle.start,
              rsi: index === 2 ? 10 : 50,
              emaFast: 1,
              emaSlow: 2,
              macd: -1,
              atr: 1,
              historicalVolatility: 0,
              momentum: 1,
              periodicReturns: { "1": 0.01 },
              ohlcvVwap: 1,
              tradeVwap: null,
              orderBookVwap: null,
              bidAskSpread: null,
              relativeVolume: 1,
              volumeSpike: false,
              volumeTrend: 0,
              vwapDeviation: 0,
              trendStrength: 100,
            },
      ),
    };

    const result = await replayBacktest(
      candles,
      {
        ...backtestConfig(registry.value),
        runId: "prepared-run",
        indicators: indicatorConfig,
      },
      prepared,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trades).toHaveLength(1);
    expect(result.value.trades[0]?.fill.executedAt).toBe(candles[3]?.start);
  });
});

const backtestConfig = (strategies: StrategyRegistry) => ({
  runId: "test-run",
  agentId: "test-agent",
  productId: product.value,
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  indicators: testIndicatorConfig,
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
