// Contôle CS4 résiduel — QUARTER uniquement : turnover ≤ 10 et
// feeRate ≤ 1 % (définitions : fees/grossTradedNotional et
// fees/initialCapital), sur les deux fenêtres, config V1 300/600.

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";
import type { ConfidenceCalibrationProfile } from "@dodash/models";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const WINDOWS = [
  { label: "bull", startAt: Date.parse("2023-08-21"), endAt: Date.parse("2024-08-21") },
  { label: "bear", startAt: Date.parse("2025-08-21"), endAt: Date.parse("2026-08-21") },
] as const;

const PROFILE: ConfidenceCalibrationProfile = "POWER_QUARTER";

const makeConfig = (window: (typeof WINDOWS)[number]): BacktestSuiteConfig =>
  ({
    runId: `confidence-sizing-quarter-${window.label}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: PROFILE,
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

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;

for (const window of WINDOWS) {
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt: window.startAt,
    endAt: window.endAt,
  });
  if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));
  const result = await runBacktestSuite(dataset.value, makeConfig(window));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
  if (!ensemble) throw new Error("missing ensemble scenario");
  const m = ensemble.metrics;
  console.log(
    `${window.label} | return ${pct(m.totalReturn)} | dd ${pct(m.maxDrawdown)} | turnover ${m.turnover.toFixed(2)} | fees $${m.fees.toFixed(0)} | feeRate/notional ${pct(m.fees / m.grossTradedNotional)} | feeRate/capital ${pct(m.fees / 10_000)}`,
  );
}
