import { describe, expect, it } from "vitest";

import {
  createOrderIntent,
  createProductId,
  createSignal,
  type Candle,
  type OrderIntent,
} from "@dodash/domain";
import { createStrategyRegistry, type Strategy } from "@dodash/strategies";

import {
  calculateMetrics,
  executePaperOrder,
  replayBacktest,
  type PaperPortfolio,
} from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

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
      indicators: {
        rsiPeriod: 2,
        emaFastPeriod: 2,
        emaSlowPeriod: 3,
        atrPeriod: 2,
      },
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
});
