// Verrou de comportement (models/daily-pnl-fidelity.md §V4) : la mesure
// dailyPnl du replay suit la fenêtre UTC de resolveDailyRiskWindow, pas le
// cumul depuis initialCapital. Scénario : BUY exécutés à deux jours UTC
// distincts, chute de prix entre les deux telle que le PnL cumulé plonge
// sous −maxDailyLoss alors que le PnL du jour est nul → l'ordre du second
// jour doit passer (l'ancienne mesure l'aurait rejeté DAILY_LOSS_LIMIT).

import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import {
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

import {
  replayBacktest,
  type BacktestConfig,
  type PreparedBacktestIndicators,
} from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const DAY = 86_400_000;

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

// BUY après warm-up aux indices 2 et 5 — deux jours UTC distincts.
const strategyWithId = (id: string): Strategy => ({
  id,
  evaluate: (context) => {
    const buy = context.candles.length === 3 || context.candles.length === 6;
    const result = createSignal({
      strategyId: id,
      productId: context.productId,
      side: buy ? "BUY" : "HOLD",
      confidence: buy ? 1 : 0,
      suggestedSize: buy ? 50 : 0,
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

const registry = createStrategyRegistry([strategyWithId("daily-pnl-probe")]);
if (!registry.ok) throw new Error("invalid strategy fixture");

const preparedFor = (
  candles: readonly Candle[],
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
        },
  ),
});

// Chute 100 → 60 entre l'exécution (open jour 3) et le second BUY (jour 5) :
// avec ~5 000 $ engagés, le PnL cumulé passe sous −2 000 $, très au-delà de
// maxDailyLoss = 100 — l'ancienne mesure cumulative rejetait le second ordre.
const candles: Candle[] = [
  { start: 0 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 1 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 2 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 3 * DAY, open: 100, high: 100, low: 89, close: 90, volume: 10 },
  { start: 4 * DAY, open: 90, high: 90, low: 59, close: 60, volume: 10 },
  { start: 5 * DAY, open: 60, high: 61, low: 59, close: 60, volume: 10 },
  { start: 6 * DAY, open: 60, high: 61, low: 59, close: 60, volume: 10 },
];

const config: BacktestConfig = {
  runId: "daily-pnl-window-test",
  agentId: "daily-pnl-window-agent",
  productId: product.value,
  intervalMs: 86_400_000,
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  indicators,
  strategies: registry.value,
  risk: {
    maxOrderNotional: 5_000,
    maxPositionNotional: 50_000,
    maxGrossExposure: 100_000,
    maxDailyLoss: 100,
    cooldownMs: 0,
    stopLossBps: 100,
    takeProfitBps: 200,
  },
  broker: { feeBps: 0, slippageBps: 0 },
};

describe("replayBacktest — fenêtre dailyPnl (models/daily-pnl-fidelity.md)", () => {
  it("un jour UTC à PnL nul ne rejette pas malgré un cumul < −maxDailyLoss", async () => {
    const result = await replayBacktest(candles, config, preparedFor(candles));
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    // Sanité du scénario : le cumul mordait bien l'ancien prédicat.
    const finalEquity =
      result.value.finalPortfolio.cash +
      result.value.finalPortfolio.positionQuantity * candles[5]!.close;
    expect(finalEquity - config.initialCapital).toBeLessThan(
      -config.risk.maxDailyLoss,
    );

    // Nouveau comportement : les deux ordres passent, aucun rejet daily.
    expect(result.value.trades.length).toBe(2);
    expect(result.value.diagnostics.allocation.riskRejectionReasons.DAILY_LOSS_LIMIT).toBe(0);
    expect(result.value.diagnostics.allocation.riskRejectedCount).toBe(0);
  });
});
