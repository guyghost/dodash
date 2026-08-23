// Walk-forward D3-P — protocole models/strategy-permission.md §6.
// 10 fenêtres annuelles (étiquettes 2016..2025, bornes [YYYY-08-21 →
// YYYY+1-08-21]) × 3 candidats de permission {C0 défaut, C1 rsi-bear-off,
// C2 rsi-off} sous config V1 (bit-identique D2-S, seul regimePermissions
// varie). Sélection par train : portes CS4 + argmax return (défaut C0).
// Critères W1-W3 sur folds propres. WF3-P : C0 reproduit les baselines.
// Contrôle d'effet : delta denied rsi > 0 + zéro fill rsi en BEARISH (C1)
// / zéro fill rsi partout (C2). Replay direct (pattern attribution,
// bit-exact suite validé INV-D1/D2) pour exposer trades + regimeGating.

import { createActor } from "xstate";

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { createProductId, type Candle } from "@dodash/domain";
import { regimeFilterMachine, type RegimeKind, type RegimePermissions } from "@dodash/models";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import { prepareBacktestIndicators } from "../src/prepared-indicators.js";
import { replayBacktest, type BacktestConfig } from "../src/index.js";
import { withConfidenceCalibration } from "../src/confidence-calibrated-strategy.js";
import { withTargetSignalNotional } from "../src/target-notional-strategy.js";
import type { BacktestSuiteConfig } from "../src/suite.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

// Espace de candidats figé a priori (§4) : un seul degré de liberté —
// la permission de rsi-reversion hors BULLISH. C0 = absence de champ
// (table par défaut, INV-P1 bit-exact V1).
type CandidateKey = "C0" | "C1" | "C2";
const CANDIDATE_KEYS: readonly CandidateKey[] = ["C0", "C1", "C2"];

const BULL_DEFAULT: readonly string[] = ["ema-cross", "breakout"];
const candidatePermissions = (
  key: CandidateKey,
): RegimePermissions | undefined =>
  key === "C0"
    ? undefined
    : key === "C1"
      ? Object.freeze({
          BULLISH: Object.freeze(BULL_DEFAULT),
          BEARISH: Object.freeze([]),
          RANGE: Object.freeze(["rsi-reversion"]),
        })
      : Object.freeze({
          BULLISH: Object.freeze(BULL_DEFAULT),
          BEARISH: Object.freeze([]),
          RANGE: Object.freeze([]),
        });

const CALIBRATED_STRATEGIES = ["ema-cross", "breakout"] as const;
const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;

// Fenêtres contaminées par la sélection in-sample d'origine
// (confidence-sizing-walkforward.md §5).
const CONTAMINATED = new Set(["2023", "2025"]);

// WF3-P : baselines V1 publiées (D2-S §8, miroir attribution INV-D2).
const WF3_EXPECTATIONS: ReadonlyArray<{
  year: string;
  ret: number;
  dd: number;
}> = [
  { year: "2023", ret: 0.0027, dd: 0.0293 },
  { year: "2025", ret: 0.0363, dd: 0.0337 },
];

const DAY = 86_400_000;
const windowBounds = (year: number): { startAt: number; endAt: number } => {
  const startAt = Date.parse(`${year}-08-21T00:00:00Z`);
  const endAt = Date.parse(`${year + 1}-08-21T00:00:00Z`);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt % DAY !== 0 || endAt % DAY !== 0) {
    throw new Error(`unaligned window ${year}`);
  }
  return { startAt, endAt };
};

// Config V1 bit-identique D2-S, SANS regimeConditionalSizing (C0 nu) ;
// regimePermissions varie (seul degré de liberté).
const suiteConfig = (year: number): BacktestSuiteConfig =>
  ({
    runId: `regime-permission-${year}`,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
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

// Miroir de strategiesById (suite.ts), calibration IDENTITY — ensemble.
const ensembleStrategies = (config: BacktestSuiteConfig): readonly Strategy[] => {
  const size = (strategy: Strategy): Strategy =>
    withTargetSignalNotional(strategy, config.targetSignalNotional);
  const calibrate = (strategy: Strategy): Strategy =>
    withConfidenceCalibration(strategy, "IDENTITY");
  return [
    size(
      createRsiReversionStrategy({
        oversold: 30,
        overbought: 70,
        baseSize: config.targetSignalNotional,
      }),
    ),
    size(calibrate(createEmaCrossStrategy({ baseSize: config.targetSignalNotional }))),
    size(
      calibrate(
        createBreakoutStrategy({
          lookback: 20,
          baseSize: config.targetSignalNotional,
        }),
      ),
    ),
  ];
};

const replayConfigFor = (
  config: BacktestSuiteConfig,
  permissions: RegimePermissions | undefined,
): BacktestConfig => {
  const registry = createStrategyRegistry(ensembleStrategies(config));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  return {
    runId: `${config.runId}:ensemble`,
    agentId: config.agentId,
    productId: product.value,
    initialCapital: config.initialCapital,
    maxDecisionNotional: config.maxDecisionNotional,
    minNetQuantity: config.minNetQuantity,
    indicators: config.indicators,
    strategies: registry.value,
    risk: config.risk,
    broker: config.broker,
    protectiveExit: config.protectiveExit,
    regimeFilter: config.regimeFilter,
    ...(permissions === undefined ? {} : { regimePermissions: permissions }),
  };
};

// Timeline régime (méthode regime-days : send CANDLE_CLOSED puis lecture).
interface RegimeDay {
  readonly closedAt: number;
  readonly regime: RegimeKind | null;
}

const regimeTimeline = async (
  candles: readonly Candle[],
  config: BacktestSuiteConfig,
): Promise<readonly RegimeDay[]> => {
  const prepared = await prepareBacktestIndicators(candles, config.indicators);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const actor = createActor(regimeFilterMachine, {
    input: { policy: config.regimeFilter! },
  });
  actor.start();
  const timeline: RegimeDay[] = [];
  for (const snapshot of prepared.value.snapshots) {
    if (snapshot === null) continue;
    if (
      !Number.isFinite(snapshot.emaFast) ||
      snapshot.emaFast <= 0 ||
      !Number.isFinite(snapshot.emaSlow) ||
      snapshot.emaSlow <= 0
    ) {
      continue;
    }
    actor.send({
      type: "CANDLE_CLOSED",
      observation: {
        start: snapshot.candleClosedAt,
        emaFast: snapshot.emaFast,
        emaSlow: snapshot.emaSlow,
      },
    });
    timeline.push({
      closedAt: snapshot.candleClosedAt,
      regime: actor.getSnapshot().context.regime,
    });
  }
  return timeline;
};

const regimeLabel = (regime: RegimeKind | null): string =>
  regime === null ? "warmUp" : regime;

const regimeAtFill = (timeline: readonly RegimeDay[], executedAt: number): string => {
  let current = "warmUp";
  for (const day of timeline) {
    if (day.closedAt > executedAt) break;
    current = regimeLabel(day.regime);
  }
  return current;
};

interface WindowMeasurement {
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
  readonly medianNotionalByStrategy: ReadonlyMap<string, number | null>;
  readonly capRate: number;
  readonly riskRejectionRate: number;
  // Contrôle d'effet §6 — la permission étant par régime, le contrôle
  // porte sur le régime des fills d'ENTRÉE (hors protective) : plus fort
  // que « zéro fill rsi » car il couvre toutes stratégies. C1 ⇒ zéro
  // entrée en BEARISH ; C2 ⇒ zéro entrée en BEARISH et RANGE.
  readonly deniedRsi: number;
  readonly entryFillsByRegime: Readonly<Record<string, number>>;
}

// Portes CS4 (§6 — règle identique D2-S/D12) + argmax return, défaut C0.
const isEligible = (m: WindowMeasurement): boolean => {
  for (const strategyId of CALIBRATED_STRATEGIES) {
    const median = m.medianNotionalByStrategy.get(strategyId);
    if (median === undefined || median === null || median < 100 || median > 400) {
      return false;
    }
  }
  return m.maxDrawdown <= 0.1 && m.turnover <= 10 && m.feeRate <= 0.01;
};

const selectOnTrain = (
  measurements: ReadonlyMap<CandidateKey, WindowMeasurement>,
): { selected: CandidateKey; eligible: CandidateKey[] } => {
  const eligible = CANDIDATE_KEYS.filter((key) =>
    isEligible(measurements.get(key) ?? (() => { throw new Error(`missing ${key}`); })()),
  );
  if (eligible.length === 0) return { selected: "C0", eligible };
  const selected = eligible.reduce((best, key) =>
    (measurements.get(key) ?? { totalReturn: -Infinity }).totalReturn >
    (measurements.get(best) ?? { totalReturn: -Infinity }).totalReturn
      ? key
      : best,
  );
  return { selected, eligible };
};

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const key = (year: number): string => `${year}`;

const byYear = new Map<string, Map<CandidateKey, WindowMeasurement>>();
const daysByRegimeByYear = new Map<string, Readonly<Record<string, number>>>();
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
  const candles = dataset.value.candles;
  console.log(`${year}: ${candles.length} candles chargées`);

  const config = suiteConfig(year);
  const timeline = await regimeTimeline(candles, config);
  const daysByRegime: Record<string, number> = {};
  for (const day of timeline) {
    const label = regimeLabel(day.regime);
    daysByRegime[label] = (daysByRegime[label] ?? 0) + 1;
  }
  daysByRegimeByYear.set(key(year), daysByRegime);
  console.log(
    `  jours régimes : ${Object.entries(daysByRegime).map(([r, n]) => `${r} ${n}`).join(" · ")}`,
  );

  // Préparation unique partagée par les 3 candidats.
  const prepared = await prepareBacktestIndicators(candles, config.indicators);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));

  const measurements = new Map<CandidateKey, WindowMeasurement>();
  for (const candidateKey of CANDIDATE_KEYS) {
    const replay = await replayBacktest(
      candles,
      replayConfigFor(config, candidatePermissions(candidateKey)),
      prepared.value,
    );
    if (!replay.ok) {
      throw new Error(`${year}/${candidateKey}: ${JSON.stringify(replay.error)}`);
    }
    const m = replay.value.metrics;
    const signals = replay.value.diagnostics.signals;
    const medianNotionalByStrategy = new Map<string, number | null>(
      signals.byStrategy.map((s) => {
        const isCalibrated = CALIBRATED_STRATEGIES.includes(
          s.strategyId as (typeof CALIBRATED_STRATEGIES)[number],
        );
        return isCalibrated ? [s.strategyId, s.requestedNotional.median] : [s.strategyId, null];
      }),
    );
    // Contrôle d'effet : fills d'ENTRÉE (clientOrderId non protective)
    // par régime au fill.
    const entryFillsByRegime: Record<string, number> = {};
    for (const trade of replay.value.trades) {
      if (!trade.fill.clientOrderId.startsWith(`${config.runId}:ensemble:protective:`)) {
        const regime = regimeAtFill(timeline, trade.fill.executedAt);
        entryFillsByRegime[regime] = (entryFillsByRegime[regime] ?? 0) + 1;
      }
    }
    const measurement: WindowMeasurement = {
      totalReturn: m.totalReturn,
      maxDrawdown: m.maxDrawdown,
      turnover: m.turnover,
      feeRate: m.grossTradedNotional > 0 ? m.fees / m.grossTradedNotional : 0,
      medianNotionalByStrategy,
      capRate: replay.value.diagnostics.allocation.capRate,
      riskRejectionRate: replay.value.diagnostics.allocation.riskRejectionRate,
      deniedRsi: replay.value.regimeGating?.deniedByStrategy["rsi-reversion"] ?? 0,
      entryFillsByRegime,
    };
    measurements.set(candidateKey, measurement);
    const medians = CALIBRATED_STRATEGIES.map(
      (id) =>
        `${id} $${measurement.medianNotionalByStrategy.get(id)?.toFixed(0) ?? "n/a"}`,
    ).join(" ");
    console.log(
      `  ${candidateKey} ret ${pct(m.totalReturn).padStart(7)} dd ${pct(m.maxDrawdown).padStart(6)} tover ${m.turnover.toFixed(2)} fee ${pct(measurement.feeRate)} | ${medians} | deniedRsi ${measurement.deniedRsi} entrées ${Object.entries(measurement.entryFillsByRegime).map(([r, n]) => `${r}:${n}`).join(",") || "aucune"}`,
    );
  }
  byYear.set(key(year), measurements);
}

// WF3-P — contrôle de non-dérive : C0 (champ absent, INV-P1) doit
// reproduire les baselines V1 bit-près.
console.log("\n== WF3-P contrôle de non-dérive (C0 vs baseline V1) ==");
let wf3Ok = true;
for (const expected of WF3_EXPECTATIONS) {
  const m = byYear.get(expected.year)?.get("C0");
  if (m === undefined) {
    console.log(`${expected.year}: absent — WF3-P non vérifiable`);
    wf3Ok = false;
    continue;
  }
  const matches =
    Math.abs(m.totalReturn - expected.ret) < 0.000_05 &&
    Math.abs(m.maxDrawdown - expected.dd) < 0.000_05;
  wf3Ok = wf3Ok && matches;
  console.log(
    `${expected.year}: ret ${pct(m.totalReturn)} (att. ${pct(expected.ret)}) dd ${pct(m.maxDrawdown)} (att. ${pct(expected.dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`WF3-P : ${wf3Ok ? "PASS" : "FAIL"}`);

// Contrôle d'effet §6 — delta denied rsi > 0 là où la policy peut mordre,
// et cohérence régime des entrées : C1 ⇒ zéro entrée en BEARISH ;
// C2 ⇒ zéro entrée en BEARISH et RANGE (contrôle renforcé : la
// permission est par régime, elle ne peut pas produire d'entrée hors
// régimes autorisés, quelle que soit la stratégie).
console.log("\n== Contrôle d'effet (policy mord) ==");
let effectOk = true;
for (const year of START_YEARS) {
  const measurements = byYear.get(key(year));
  if (measurements === undefined) continue;
  const days = daysByRegimeByYear.get(key(year))!;
  const bearDays = days["BEARISH"] ?? 0;
  const rangeDays = days["RANGE"] ?? 0;
  const deniedC0 = measurements.get("C0")!.deniedRsi;
  const c1 = measurements.get("C1")!;
  const c2 = measurements.get("C2")!;
  const delta1 = c1.deniedRsi - deniedC0;
  const delta2 = c2.deniedRsi - deniedC0;
  // C1 ne peut mordre que si des jours BEARISH existent ; C2 si
  // BEARISH ou RANGE existent.
  const c1CanBite = bearDays > 0;
  const c2CanBite = bearDays + rangeDays > 0;
  const c1Ok =
    (!c1CanBite || delta1 > 0) && (c1.entryFillsByRegime["BEARISH"] ?? 0) === 0;
  const c2Ok =
    (!c2CanBite || delta2 > 0) &&
    (c2.entryFillsByRegime["BEARISH"] ?? 0) === 0 &&
    (c2.entryFillsByRegime["RANGE"] ?? 0) === 0;
  effectOk = effectOk && c1Ok && c2Ok;
  console.log(
    `${year}: C1 Δdenied ${delta1} entréesBEARISH ${c1.entryFillsByRegime["BEARISH"] ?? 0} ${c1Ok ? "OK" : "FAIL"}${c1CanBite ? "" : " (aucun jour BEARISH)"} | C2 Δdenied ${delta2} entréesBEARISH/RANGE ${c2.entryFillsByRegime["BEARISH"] ?? 0}/${c2.entryFillsByRegime["RANGE"] ?? 0} ${c2Ok ? "OK" : "FAIL"}${c2CanBite ? "" : " (aucun jour BEARISH/RANGE)"}`,
  );
}
console.log(`Contrôle d'effet : ${effectOk ? "PASS" : "FAIL"}`);

// Sélection par fenêtre + folds.
console.log("\n== Sélection par train et folds OOS ==");
interface Fold {
  readonly trainYear: number;
  readonly testYear: number;
  readonly clean: boolean;
  readonly selected: CandidateKey;
  readonly eligible: readonly CandidateKey[];
  readonly selectedTestReturn: number;
  readonly defaultTestReturn: number;
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
    clean:
      !CONTAMINATED.has(key(trainYear)) && !CONTAMINATED.has(key(testYear)),
    selected,
    eligible,
    selectedTestReturn: test.get(selected)!.totalReturn,
    defaultTestReturn: test.get("C0")!.totalReturn,
  });
  console.log(
    `train ${trainYear}→${trainYear + 1} (${CONTAMINATED.has(key(trainYear)) ? "CONTAMINÉ" : "propre"}) | éligibles [${eligible.join(", ") || "aucun"}] → ${selected} | test ${testYear}→${testYear + 1} (${CONTAMINATED.has(key(testYear)) ? "CONTAMINÉ" : "propre"}) : ${selected} ${pct(test.get(selected)!.totalReturn)} vs C0 ${pct(test.get("C0")!.totalReturn)} ${test.get(selected)!.totalReturn > test.get("C0")!.totalReturn ? "→ bat" : "→ ne bat pas"}`,
  );
}

// Critères W1-W3 (§7, folds propres uniquement).
console.log("\n== Critères a priori (folds propres) ==");
const cleanFolds = folds.filter((f) => f.clean);
console.log(`folds propres : ${cleanFolds.length}`);
const selectionCounts = new Map<CandidateKey, number>();
for (const f of cleanFolds) {
  selectionCounts.set(f.selected, (selectionCounts.get(f.selected) ?? 0) + 1);
}
const [mostSelected, mostSelectedCount] = [...selectionCounts.entries()].sort(
  (a, b) => b[1] - a[1],
)[0] ?? ["C0", 0];
const beats = cleanFolds.filter(
  (f) => f.selectedTestReturn > f.defaultTestReturn,
).length;
const spreads = cleanFolds
  .map((f) => f.selectedTestReturn - f.defaultTestReturn)
  .sort((a, b) => a - b);
const medianSpread =
  spreads.length % 2 === 1
    ? spreads[(spreads.length - 1) / 2]!
    : (spreads[spreads.length / 2 - 1]! + spreads[spreads.length / 2]!) / 2;
// W3 : dd test ≤ 10 % pour le candidat sélectionné, folds propres.
const ddViolations = cleanFolds.filter((f) => {
  const m = byYear.get(key(f.testYear))!.get(f.selected)!;
  return m.maxDrawdown > 0.1;
});
const requiredFolds = 4;
const w1 = mostSelectedCount >= requiredFolds;
const w2 = beats >= requiredFolds && medianSpread > 0;
const w3 = ddViolations.length === 0;
console.log(
  `W1 stabilité : ${mostSelected} sélectionné sur ${mostSelectedCount}/${cleanFolds.length} trains propres (≥4 requis) → ${w1 ? "PASS" : "FAIL"}`,
);
console.log(
  `W2 OOS : sélectionné bat C0 sur ${beats}/${cleanFolds.length} tests propres (≥4 requis), spread médian ${pct(medianSpread)} (>0 requis) → ${w2 ? "PASS" : "FAIL"}`,
);
console.log(
  `W3 sécurité : ${ddViolations.length} violation(s) dd > 10 % en test propre → ${w3 ? "PASS" : "FAIL"}`,
);

const verdict = w1 && w2 && w3 && wf3Ok && effectOk;
console.log(
  `\nVERDICT D3-P : ${verdict ? "VALIDÉ" : "DÉCLASSÉ"} (W1 ${w1 ? "P" : "F"} · W2 ${w2 ? "P" : "F"} · W3 ${w3 ? "P" : "F"} · WF3-P ${wf3Ok ? "P" : "F"} · effet ${effectOk ? "P" : "F"})`,
);
