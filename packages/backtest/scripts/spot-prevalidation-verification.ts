// Vérification D2' — protocole models/spot-prevalidation.md §6-7.
// 4 runs de référence sous config V1 bit-identique à la campagne D2 :
//   2023 IDENTITY, 2025 IDENTITY (baselines WF2 économiques),
//   2022 IDENTITY (riskRej 23,08 %, SPOT seul → attendu 0 % post),
//   2016 QUARTER  (13 SPOT + 3 POSITION → attendu 3 POSITION seuls).
// Émet un JSON par run pour comparaison pré/post bit-identique
// (totalReturn, maxDrawdown, winRate, profitFactor, trades).

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
    runId: `spot-verification-${year}-${profile}`,
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

const CASES: ReadonlyArray<{ year: number; profile: ConfidenceCalibrationProfile }> = [
  { year: 2023, profile: "IDENTITY" },
  { year: 2025, profile: "IDENTITY" },
  { year: 2022, profile: "IDENTITY" },
  { year: 2016, profile: "POWER_QUARTER" },
];

for (const { year, profile } of CASES) {
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
      opportunityCount: allocation.opportunityCount,
      riskEvaluationCount: allocation.riskEvaluationCount,
      riskRejectedCount: allocation.riskRejectedCount,
      riskRejectionRate: allocation.riskRejectionRate,
      spotInexecutableCount: allocation.spotInexecutableCount ?? null,
      spotShortForbidden: allocation.riskRejectionReasons.SPOT_SHORT_FORBIDDEN,
      positionNotionalLimit: allocation.riskRejectionReasons.POSITION_NOTIONAL_LIMIT,
      dailyLossLimit: allocation.riskRejectionReasons.DAILY_LOSS_LIMIT,
    }),
  );
}
