// Campagne de mesure — sizing par calibration de confiance v1
// (modèle models/confidence-sizing.md, cycle Model→Verify). Variable
// unique : confidenceCalibration ∈ {IDENTITY, HALF, THIRD, QUARTER},
// exits V1 (bull NONE, bear/range/warmUp FIXED 600/600), gate
// EMA_THRESHOLD 100/5/3. Critères a priori : composite > +3,90 %,
// dd ≤ 10 % deux fenêtres, notion médiane par stratégie ∈ [100, 400],
// bear ≥ +3 %. CS2 : IDENTITY doit reproduire V1 (+0,27 % | +3,63 %).

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";
import type { ConfidenceCalibrationProfile } from "@dodash/models";

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

const PROFILES: readonly ConfidenceCalibrationProfile[] = [
  "IDENTITY",
  "POWER_HALF",
  "POWER_THIRD",
  "POWER_QUARTER",
];

// Contrôle CS2 : cellule sans le champ (config V1 historique à vide).
const UNSET = "__UNSET__" as const;
type Cell = ConfidenceCalibrationProfile | typeof UNSET;
const CELLS: readonly Cell[] = [UNSET, "IDENTITY", "POWER_HALF", "POWER_THIRD", "POWER_QUARTER"];

const makeConfig = (
  profile: Cell,
  window: WindowSpec,
): BacktestSuiteConfig =>
  ({
    runId: `confidence-sizing-${profile}-${window.label}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    ...(profile === UNSET ? {} : { confidenceCalibration: profile }),
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

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : (((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

for (const window of WINDOWS) {
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt: window.startAt,
    endAt: window.endAt,
  });
  if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));
  const lastCandle = dataset.value.candles.at(-1);
  console.log(`\n=== fenêtre ${window.label} ${new Date(window.startAt).toISOString().slice(0, 10)}→${new Date(window.endAt).toISOString().slice(0, 10)} — ${dataset.value.candles.length} bougies, dernière ${lastCandle ? new Date(lastCandle.start).toISOString().slice(0, 10) : "?"} ===`);
  console.log("profil | return | dd | win | trades | stops | takes | amb | notional médian (par stratégie, ids réels)");
  for (const profile of CELLS) {
    const result = await runBacktestSuite(
      dataset.value,
      makeConfig(profile, window),
      { includeDiagnosticSamples: true },
    );
    if (!result.ok) {
      console.log(`${profile} | ERROR ${JSON.stringify(result.error)}`);
      continue;
    }
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) continue;
    const m = ensemble.metrics;
    const samples = ensemble.diagnosticSamples?.requestedNotionalByStrategy ?? [];
    const notionals = samples
      .map((s) => {
        const med = median(s.values);
        return `${s.strategyId}:${med === null ? "n/a" : `$${med.toFixed(0)}`}(${s.values.length})`;
      })
      .join(" ");
    console.log(
      `${profile} | ${pct(m.totalReturn)} | ${pct(m.maxDrawdown)} | ${pct(m.winRate)} | ${ensemble.tradeCount} | ${ensemble.stopLossExitCount} | ${ensemble.takeProfitExitCount} | ${ensemble.ambiguousExitCount} | ${notionals}`,
    );
  }
}
