// Diagnostic ad hoc (hors cycle Model→…, ne modifie aucun workflow) :
// attribue l'écart d'excess vs buy-and-hold en année bull à des variantes
// isolées de RiskConfig. Variante = un seul paramètre changé vs cli.ts.

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const dataset = await loadCoinbaseHistoricalDataset({
  productId: "BTC-USD",
  timeframe: "ONE_DAY",
  startAt: Date.parse("2023-08-21"),
  endAt: Date.parse("2024-08-21"),
});
if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));

const baseRisk = {
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
} as const;

const variants: readonly (readonly [string, Partial<typeof baseRisk>])[] = [
  ["baseline", {}],
  ["no-daily-loss-limit", { maxDailyLoss: 1e12 }],
  ["order-limit-10k", { maxOrderNotional: 10_000 }],
  ["position-limit-100k", { maxPositionNotional: 100_000 }],
  ["gross-limit-200k", { maxGrossExposure: 200_000 }],
];

const makeConfig = (
  label: string,
  riskOverride: Partial<typeof baseRisk>,
): BacktestSuiteConfig =>
  ({
    runId: `diag-${label}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: "IDENTITY",
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: { ...baseRisk, ...riskOverride },
    broker: { feeBps: 6, slippageBps: 2 },
    protectiveExit: {
      mode: "FIXED_BPS",
      stopLossBps: 300,
      takeProfitBps: 600,
    },
  }) as BacktestSuiteConfig;

for (const [label, override] of variants) {
  const result = await runBacktestSuite(dataset.value, makeConfig(label, override));
  if (!result.ok) {
    console.log(`${label}: ERROR ${JSON.stringify(result.error)}`);
    continue;
  }
  const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
  if (!ensemble) continue;
  const alloc = ensemble.diagnostics.allocation;
  console.log(
    `${label}: ret=${(ensemble.metrics.totalReturn * 100).toFixed(2)}% trades=${ensemble.tradeCount} winRate=${(ensemble.metrics.winRate * 100).toFixed(0)}% riskReject=${(alloc.riskRejectionRate * 100).toFixed(1)}% approvedMedian=$${alloc.riskApprovedNotional.median.toFixed(0)}`,
  );
}
