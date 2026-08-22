// Walk-forward W — protocole models/confidence-sizing-walkforward.md §3.
// 10 fenêtres annuelles (2016→2026) × 4 profils sous config V1 300/600.
// Sélection par train : portes CS4 + argmax return (fonction pure).
// Critères W1-W3 évalués sur les folds propres uniquement.

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId } from "@dodash/domain";
import type { ConfidenceCalibrationProfile } from "@dodash/models";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import type { BacktestSuiteConfig } from "../src/suite.js";
import { runBacktestSuite } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const PROFILES: readonly ConfidenceCalibrationProfile[] = [
  "IDENTITY",
  "POWER_HALF",
  "POWER_THIRD",
  "POWER_QUARTER",
];
const CALIBRATED_STRATEGIES = ["ema-cross", "breakout"] as const;
const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;

// Fenêtres contaminées par la sélection in-sample d'origine (sizing §5).
const CONTAMINATED = new Set(["2023", "2025"]);

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
    runId: `walkforward-${year}-${profile}`,
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

interface WindowMeasurement {
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
  readonly medianNotionalByStrategy: ReadonlyMap<string, number | null>;
  readonly capRate: number;
  readonly riskRejectionRate: number;
}

// Règle §3 : portes CS4 par stratégie calibrée + dd/turnover/fees,
// argmax return parmi éligibles, défaut IDENTITY. Fonction pure.
const isEligible = (m: WindowMeasurement): boolean => {
  for (const strategyId of CALIBRATED_STRATEGIES) {
    const median = m.medianNotionalByStrategy.get(strategyId);
    if (median === undefined || median === null || median < 100 || median > 400) {
      return false;
    }
  }
  return (
    m.maxDrawdown <= 0.1 &&
    m.turnover <= 10 &&
    m.feeRate <= 0.01
  );
};

const selectOnTrain = (
  measurements: ReadonlyMap<ConfidenceCalibrationProfile, WindowMeasurement>,
): { selected: ConfidenceCalibrationProfile; eligible: ConfidenceCalibrationProfile[] } => {
  const eligible = PROFILES.filter((profile) =>
    isEligible(measurements.get(profile) ?? (() => { throw new Error(`missing ${profile}`); })()),
  );
  if (eligible.length === 0) {
    return { selected: "IDENTITY", eligible };
  }
  const selected = eligible.reduce((best, profile) =>
    (measurements.get(profile) ?? { totalReturn: -Infinity }).totalReturn >
    (measurements.get(best) ?? { totalReturn: -Infinity }).totalReturn
      ? profile
      : best,
  );
  return { selected, eligible };
};

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const key = (year: number): string => `${year}`;

const byYear = new Map<string, Map<ConfidenceCalibrationProfile, WindowMeasurement>>();
const unavailable = new Set<string>();

for (const year of START_YEARS) {
  const { startAt, endAt } = windowBounds(year);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) {
    console.log(`${year}: DONNÉES INDISPONIBLES (${dataset.error.code}) — folds éliminés`);
    unavailable.add(key(year));
    continue;
  }
  console.log(`${year}: ${dataset.value.candles.length} candles chargées`);
  const measurements = new Map<ConfidenceCalibrationProfile, WindowMeasurement>();
  for (const profile of PROFILES) {
    const result = await runBacktestSuite(dataset.value, makeConfig(year, profile));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const ensemble = result.value.scenarios.find((s) => s.id === "ensemble");
    if (!ensemble) throw new Error(`missing ensemble scenario ${year}/${profile}`);
    const m = ensemble.metrics;
    const signals = ensemble.diagnostics.signals;
    const medianNotionalByStrategy = new Map<string, number | null>(
      signals.byStrategy.map((s) => {
        const entry = CALIBRATED_STRATEGIES.includes(s.strategyId as (typeof CALIBRATED_STRATEGIES)[number])
          ? s.strategyId
          : null;
        return entry === null ? [s.strategyId, null] : [entry, s.requestedNotional.median];
      }),
    );
    const measurement: WindowMeasurement = {
      totalReturn: m.totalReturn,
      maxDrawdown: m.maxDrawdown,
      turnover: m.turnover,
      feeRate: m.grossTradedNotional > 0 ? m.fees / m.grossTradedNotional : 0,
      medianNotionalByStrategy,
      capRate: ensemble.diagnostics.allocation.capRate,
      riskRejectionRate: ensemble.diagnostics.allocation.riskRejectionRate,    };
    measurements.set(profile, measurement);
    const medians = CALIBRATED_STRATEGIES
      .map((id) => `${id} $${measurement.medianNotionalByStrategy.get(id)?.toFixed(0) ?? "n/a"}`)
      .join(" ");
    console.log(
      `  ${profile.padEnd(14)} ret ${pct(m.totalReturn).padStart(7)} dd ${pct(m.maxDrawdown).padStart(6)} tover ${m.turnover.toFixed(2)} fee ${pct(measurement.feeRate)} | ${medians} | cap ${pct(measurement.capRate)} riskRej ${pct(measurement.riskRejectionRate)}`,
    );
  }
  byYear.set(key(year), measurements);
}

// WF2 — contrôle de non-dérive sur les fenêtres contaminées connues.
console.log("\n== WF2 contrôle de non-dérive (IDENTITY vs baseline V1) ==");
const wf2Expectations: ReadonlyArray<{ year: string; ret: number; dd: number }> = [
  { year: "2023", ret: 0.0027, dd: 0.0293 },
  { year: "2025", ret: 0.0363, dd: 0.0337 },
];
let wf2Ok = true;
for (const expected of wf2Expectations) {
  const m = byYear.get(expected.year)?.get("IDENTITY");
  if (m === undefined) {
    console.log(`${expected.year}: absent — WF2 non vérifiable`);
    wf2Ok = false;
    continue;
  }
  const matches =
    Math.abs(m.totalReturn - expected.ret) < 0.000_05 &&
    Math.abs(m.maxDrawdown - expected.dd) < 0.000_05;
  wf2Ok = wf2Ok && matches;
  console.log(
    `${expected.year}: ret ${pct(m.totalReturn)} (att. ${pct(expected.ret)}) dd ${pct(m.maxDrawdown)} (att. ${pct(expected.dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`WF2 : ${wf2Ok ? "PASS" : "FAIL"}`);

// Sélection par fenêtre + folds.
console.log("\n== Sélection par train et folds OOS ==");
interface Fold {
  readonly trainYear: number;
  readonly testYear: number;
  readonly clean: boolean;
  readonly selected: ConfidenceCalibrationProfile;
  readonly eligible: readonly ConfidenceCalibrationProfile[];
  readonly selectedTestReturn: number;
  readonly identityTestReturn: number;
}
const folds: Fold[] = [];
for (let i = 0; i < START_YEARS.length - 1; i++) {
  const trainYear = START_YEARS[i]!;
  const testYear = START_YEARS[i + 1]!;
  if (unavailable.has(key(trainYear)) || unavailable.has(key(testYear))) continue;
  const train = byYear.get(key(trainYear))!;
  const test = byYear.get(key(testYear))!;
  const { selected, eligible } = selectOnTrain(train);
  folds.push({
    trainYear,
    testYear,
    clean: !CONTAMINATED.has(key(trainYear)) && !CONTAMINATED.has(key(testYear)),
    selected,
    eligible,
    selectedTestReturn: test.get(selected)!.totalReturn,
    identityTestReturn: test.get("IDENTITY")!.totalReturn,
  });
  console.log(
    `train ${trainYear}→${trainYear + 1} (${CONTAMINATED.has(key(trainYear)) ? "CONTAMINÉ" : "propre"}) | éligibles [${eligible.join(", ") || "aucun"}] → ${selected} | test ${testYear}→${testYear + 1} (${CONTAMINATED.has(key(testYear)) ? "CONTAMINÉ" : "propre"}) : ${selected} ${pct(test.get(selected)!.totalReturn)} vs IDENTITY ${pct(test.get("IDENTITY")!.totalReturn)} ${test.get(selected)!.totalReturn > test.get("IDENTITY")!.totalReturn ? "→ bat" : "→ ne bat pas"}`,
  );
}

// Critères W1-W3 (folds propres uniquement).
console.log("\n== Critères a priori (folds propres) ==");
const cleanFolds = folds.filter((f) => f.clean);
console.log(`folds propres : ${cleanFolds.length}`);
const quarterSelected = cleanFolds.filter((f) => f.selected === "POWER_QUARTER").length;
const beats = cleanFolds.filter((f) => f.selectedTestReturn > f.identityTestReturn).length;
const spreads = cleanFolds.map((f) => f.selectedTestReturn - f.identityTestReturn).sort((a, b) => a - b);
const medianSpread = spreads.length % 2 === 1
  ? spreads[(spreads.length - 1) / 2]!
  : (spreads[spreads.length / 2 - 1]! + spreads[spreads.length / 2]!) / 2;
const gateViolations = cleanFolds.filter((f) => {
  const m = byYear.get(key(f.testYear))!.get(f.selected)!;
  return m.maxDrawdown > 0.1 || m.turnover > 10 || m.feeRate > 0.01;
});
const w1 = quarterSelected >= 4;
const w2 = beats >= 4 && medianSpread > 0;
const w3 = gateViolations.length === 0;
console.log(`W1 stabilité : QUARTER sélectionné sur ${quarterSelected}/${cleanFolds.length} trains propres (≥4 requis) → ${w1 ? "PASS" : "FAIL"}`);
console.log(`W2 OOS : sélectionné bat IDENTITY sur ${beats}/${cleanFolds.length} tests propres (≥4 requis), spread médian ${pct(medianSpread)} (>0 requis) → ${w2 ? "PASS" : "FAIL"}`);
console.log(`W3 sécurité : ${gateViolations.length} violation(s) de porte en test propre → ${w3 ? "PASS" : "FAIL"}`);

// Colonnes d'information déploiement (revue §correction 1).
console.log("\n== Information déploiement : capRate/riskRejection QUARTER par fenêtre ==");
for (const year of START_YEARS) {
  const m = byYear.get(key(year))?.get("POWER_QUARTER");
  if (m === undefined) continue;
  const flag = m.capRate > 0 || m.riskRejectionRate > 0 ? "⚠️ sélecteur déployé refuserait" : "ok";
  console.log(`${year}: cap ${pct(m.capRate)} riskRej ${pct(m.riskRejectionRate)} — ${flag}`);
}

const verdict = w1 && w2 && w3 ? "VALIDÉ" : "DÉCLASSÉ";
console.log(`\nVERDICT W1∧W2∧W3 : ${verdict}${wf2Ok ? "" : " (WF2 FAIL — mesure invalide)"}`);
