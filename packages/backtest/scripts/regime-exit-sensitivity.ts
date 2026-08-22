// Étude V2 (hors cycle Model→…, ne modifie aucun workflow) :
// mesure la grille range x bearish du doc models/regime-exit-v2.md sur les
// fenêtres bull et bear, via runBacktestSuite. Affiche le tableau des
// métriques ensemble pour verdict manuel selon les critères a priori.

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

type Arm = { readonly mode: "NONE" } | { readonly mode: "FIXED_BPS"; readonly stopLossBps: number; readonly takeProfitBps: number };

const NONE: Arm = { mode: "NONE" };
const fixed = (stopLossBps: number, takeProfitBps: number): Arm => ({
  mode: "FIXED_BPS",
  stopLossBps,
  takeProfitBps,
});

interface Cell {
  readonly id: string;
  readonly range: Arm;
  readonly bearish: Arm;
}

const CELLS: readonly Cell[] = [
  { id: "A1", range: fixed(300, 600), bearish: fixed(300, 600) },
  { id: "A2", range: fixed(300, 600), bearish: fixed(600, 1200) },
  { id: "B1", range: NONE, bearish: fixed(300, 600) },
  { id: "B2", range: NONE, bearish: fixed(600, 1200) },
  { id: "C1", range: fixed(600, 1200), bearish: fixed(300, 600) },
  { id: "C2", range: fixed(600, 1200), bearish: fixed(600, 1200) },
];

const makeConfig = (cell: Cell, window: WindowSpec): BacktestSuiteConfig =>
  ({
    runId: `regime-exit-v2-${cell.id}-${window.label}`,
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
      bullish: { mode: "NONE" },
      bearish: cell.bearish,
      range: cell.range,
      warmUp: cell.bearish,
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
  console.log("cell | range | bearish | return | dd | win | trades | stops | takes | amb");
  for (const cell of CELLS) {
    const armLabel = (arm: Arm): string =>
      arm.mode === "NONE" ? "NONE" : `${arm.stopLossBps}/${arm.takeProfitBps}`;
    const result = await runBacktestSuite(
      dataset.value,
      makeConfig(cell, window),
    );
    if (!result.ok) {
      console.log(`${cell.id} | ${armLabel(cell.range)} | ${armLabel(cell.bearish)} | ERROR ${JSON.stringify(result.error)}`);
      continue;
    }
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) continue;
    const m = ensemble.metrics;
    console.log(
      `${cell.id} | ${armLabel(cell.range)} | ${armLabel(cell.bearish)} | ${pct(m.totalReturn)} | ${pct(m.maxDrawdown)} | ${pct(m.winRate)} | ${ensemble.tradeCount} | ${ensemble.stopLossExitCount} | ${ensemble.takeProfitExitCount} | ${ensemble.ambiguousExitCount}`,
    );
  }
}
