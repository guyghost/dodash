// Étude bras hétérogènes par régime v3 (modèle
// models/regime-exit-v3.md, cycle complet Model→Verify) : bras bullish
// TRAILING {500, 700}, bras bearish/range/warmUp FIXED 600/600, même
// gating de régime que V1 (EMA_THRESHOLD 100/5/3). Hypothèse : le
// trail verrouille la tendance bull sans la tronquer (pas de TP), le
// FIXED récolte les rallyes bear. Critères a priori : bull ≥ +3 %,
// bear > 0 %, dd ≤ 10 % sur les deux fenêtres, même cellule.

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

interface WindowSpec {
  readonly label: "bull" | "bear";
  readonly startAt: number;
  readonly endAt: number;
}

const WINDOWS: readonly WindowSpec[] = [
  { label: "bull", startAt: Date.parse("2023-08-21"), endAt: Date.parse("2024-08-21") },
  { label: "bear", startAt: Date.parse("2025-08-21"), endAt: Date.parse("2026-08-21") },
];

const CELLS: readonly { id: string; bullTrailBps: number }[] = [
  { id: "C1", bullTrailBps: 500 },
  { id: "C2", bullTrailBps: 700 },
];

const makeConfig = (
  cell: { bullTrailBps: number },
  window: WindowSpec,
): BacktestSuiteConfig =>
  ({
    runId: `regime-exit-v3-${cell.bullTrailBps}-${window.label}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: "IDENTITY",
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
      bullish: { mode: "TRAILING_BPS", trailBps: cell.bullTrailBps },
      bearish: { mode: "FIXED_BPS", stopLossBps: 600, takeProfitBps: 600 },
      range: { mode: "FIXED_BPS", stopLossBps: 600, takeProfitBps: 600 },
      warmUp: { mode: "FIXED_BPS", stopLossBps: 600, takeProfitBps: 600 },
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

  console.log(`\n=== fenêtre ${window.label} ${new Date(window.startAt).toISOString().slice(0, 10)}→${new Date(window.endAt).toISOString().slice(0, 10)} ===`);
  console.log("cell | bullTrail | return | dd | win | trades | stops | takes | amb");
  for (const cell of CELLS) {
    const result = await runBacktestSuite(
      dataset.value,
      makeConfig(cell, window),
    );
    if (!result.ok) {
      console.log(`${cell.id} | ${cell.bullTrailBps} | ERROR ${JSON.stringify(result.error)}`);
      continue;
    }
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) continue;
    const m = ensemble.metrics;
    console.log(
      `${cell.id} | ${cell.bullTrailBps} | ${pct(m.totalReturn)} | ${pct(m.maxDrawdown)} | ${pct(m.winRate)} | ${ensemble.tradeCount} | ${ensemble.stopLossExitCount} | ${ensemble.takeProfitExitCount} | ${ensemble.ambiguousExitCount}`,
    );
  }
}
