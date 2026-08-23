// Étude trailing + take-profit combiné (modèle
// models/trailing-take-profit.md, cycle complet Model→Verify) : grille
// 2×2 trailBps ∈ {300, 500} × takeProfitBps ∈ {600, 900} sur les
// fenêtres bull et bear, même gating de régime que V1 et T1–T3
// (EMA_THRESHOLD 100/5/3). Hypothèse : le TP récolte les rallyes bear
// (V1 les prenait à TP 600), le trail verrouille les rebonds bull (T3).
// Critères a priori : bull ≥ +3 %, bear > 0 %, dd ≤ 10 % sur les deux
// fenêtres, même cellule.

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

const CELLS: readonly { id: string; trailBps: number; takeProfitBps: number }[] = [
  { id: "C1", trailBps: 300, takeProfitBps: 600 },
  { id: "C2", trailBps: 300, takeProfitBps: 900 },
  { id: "C3", trailBps: 500, takeProfitBps: 600 },
  { id: "C4", trailBps: 500, takeProfitBps: 900 },
];

const makeConfig = (
  cell: { trailBps: number; takeProfitBps: number },
  window: WindowSpec,
): BacktestSuiteConfig =>
  ({
    runId: `trailing-take-${cell.trailBps}-${cell.takeProfitBps}-${window.label}`,
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
      mode: "TRAILING_BPS",
      trailBps: cell.trailBps,
      takeProfitBps: cell.takeProfitBps,
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
  console.log("cell | trail | take | return | dd | win | trades | stops | takes | amb");
  for (const cell of CELLS) {
    const result = await runBacktestSuite(
      dataset.value,
      makeConfig(cell, window),
    );
    if (!result.ok) {
      console.log(`${cell.id} | ${cell.trailBps} | ${cell.takeProfitBps} | ERROR ${JSON.stringify(result.error)}`);
      continue;
    }
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) continue;
    const m = ensemble.metrics;
    console.log(
      `${cell.id} | ${cell.trailBps} | ${cell.takeProfitBps} | ${pct(m.totalReturn)} | ${pct(m.maxDrawdown)} | ${pct(m.winRate)} | ${ensemble.tradeCount} | ${ensemble.stopLossExitCount} | ${ensemble.takeProfitExitCount} | ${ensemble.ambiguousExitCount}`,
    );
  }
}
