// Campagne D2'' — models/daily-pnl-fidelity.md §6.
// 10 fenêtres annuelles × 4 profils, config V1 bit-identique à D2.
// Émet un JSON par run pour diff pré/post (stash) bit-à-bit.

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";
import type { ConfidenceCalibrationProfile } from "@dodash/models";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const DAY = 86_400_000;
const windowBounds = (year: number): { startAt: number; endAt: number } => {
  const startAt = Date.parse(`${year}-08-21T00:00:00Z`);
  const endAt = Date.parse(`${year + 1}-08-21T00:00:00Z`);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt % DAY !== 0 || endAt % DAY !== 0) {
    throw new Error(`unaligned window ${year}`);
  }
  return { startAt, endAt };
};

const makeConfig = (
  year: number,
  profile: ConfidenceCalibrationProfile,
): BacktestSuiteConfig =>
  ({
    runId: `dailypnl-campaign-${year}-${profile}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: profile,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: {
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
      maxGrossExposure: 20_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    },
    broker: { feeBps: 6, slippageBps: 2 },
    protectiveExit: {
      mode: "REGIME_CONDITIONAL",
      bullish: { mode: "NONE" },
      bearish: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      range: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
      warmUp: { mode: "FIXED_BPS", stopLossBps: 300, takeProfitBps: 600 },
    },
    regimeFilter: {
      mode: "EMA_THRESHOLD",
      thresholdBps: 100,
      minObservations: 5,
      confirmationCount: 3,
    },
  }) as BacktestSuiteConfig;

const PROFILES: readonly ConfidenceCalibrationProfile[] = [
  "IDENTITY",
  "POWER_QUARTER",
  "POWER_THIRD",
  "POWER_HALF",
];
const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;

for (const year of START_YEARS) {
  for (const profile of PROFILES) {
    const { startAt, endAt } = windowBounds(year);
    const dataset = await loadCoinbaseHistoricalDataset({
      productId: product.value,
      timeframe: "ONE_DAY",
      startAt,
      endAt,
    });
    if (!dataset.ok) throw new Error(`data unavailable ${year}`);
    const result = await runBacktestSuite(dataset.value, makeConfig(year, profile));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) throw new Error(`missing ensemble scenario ${year}/${profile}`);
    const allocation = ensemble.diagnostics.allocation;
    console.log(
      JSON.stringify({
        year,
        profile,
        totalReturn: ensemble.metrics.totalReturn,
        maxDrawdown: ensemble.metrics.maxDrawdown,
        winRate: ensemble.metrics.winRate,
        profitFactor: ensemble.metrics.profitFactor,
        trades: ensemble.tradeCount,
        riskEvaluationCount: allocation.riskEvaluationCount,
        riskRejectedCount: allocation.riskRejectedCount,
        riskRejectionRate: allocation.riskRejectionRate,
        spotInexecutableCount: allocation.spotInexecutableCount ?? null,
        dailyLossLimit: allocation.riskRejectionReasons.DAILY_LOSS_LIMIT,
        positionNotionalLimit: allocation.riskRejectionReasons.POSITION_NOTIONAL_LIMIT,
        spotShortForbidden: allocation.riskRejectionReasons.SPOT_SHORT_FORBIDDEN,
        cooldownActive: allocation.riskRejectionReasons.COOLDOWN_ACTIVE,
        orderNotionalLimit: allocation.riskRejectionReasons.ORDER_NOTIONAL_LIMIT,
      }),
    );
  }
}
