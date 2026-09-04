// Walk-forward H-P2 — models/regime-aware-selector.md (pré-enregistré a priori).
// Grille identique D3-P2 (10 fenêtres × {C0,C1,C2}, config V1 bit-exacte,
// préparation partagée). Sélection par train selon R-H2 : F = (jours
// BEARISH+RANGE)/(jours observés) ≥ 0,5 ∧ C2 éligible (portes D3-P2 sans
// borne médiane) → C2, sinon C0. Comparaison : règle argmax D3-P2
// recalculée sur la même grille. WF3-R : baselines V1 + reproduction de la
// grille publiée D3-P2 §8. Critères W1-r/W2-r/W3-r sur folds propres.
// Exécution : node --experimental-strip-types scripts/regime-aware-selector-walkforward.ts
// (depuis packages/backtest, après pnpm build).

import { createActor } from "xstate";

import {
  loadCoinbaseHistoricalDataset,
  prepareBacktestIndicators,
  replayBacktest,
  withConfidenceCalibration,
  withTargetSignalNotional,
  type BacktestConfig,
} from "@dodash/backtest";
import {
  TIMEFRAME_MILLISECONDS,
  createProductId,
  type Candle,
} from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  regimeFilterMachine,
  type RegimeKind,
  type RegimePermissions,
} from "@dodash/models";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

// Espace de candidats figé (strategy-permission.md §4) — identique D3-P2.
type CandidateKey = "C0" | "C1" | "C2";
const CANDIDATE_KEYS: readonly CandidateKey[] = ["C0", "C1", "C2"];

const BULL_DEFAULT: readonly string[] = ["ema-cross", "breakout"];
const candidatePermissions = (key: CandidateKey): RegimePermissions | undefined =>
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

const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const CONTAMINATED = new Set(["2023", "2025"]);

// WF3-R (1/2) — baselines V1 publiées (tol 5e-5, miroir WF3-P).
const WF3_EXPECTATIONS: ReadonlyArray<{ year: string; ret: number; dd: number }> = [
  { year: "2023", ret: 0.0027, dd: 0.0293 },
  { year: "2025", ret: 0.0363, dd: 0.0337 },
];

// WF3-R (2/2) — reproduction de la grille publiée D3-P2 §8 (ret/dd,
// publiés à 2 décimales → tol 1e-4). 2016 non publiée en D3-P (réseau) ;
// C0 2016 contrôlé contre la ligne ensemble D2-S (+2,35 %).
const PUBLISHED_GRID: ReadonlyArray<{
  year: string;
  c0: readonly [number, number];
  c1: readonly [number, number];
  c2: readonly [number, number];
}> = [
  { year: "2017", c0: [0.0385, 0.0688], c1: [0.0588, 0.063], c2: [0.0622, 0.063] },
  { year: "2018", c0: [0.0348, 0.0348], c1: [0.0414, 0.0345], c2: [0.037, 0.0347] },
  { year: "2019", c0: [-0.026, 0.0345], c1: [-0.0023, 0.0106], c2: [-0.0014, 0.003] },
  { year: "2020", c0: [0.1133, 0.0482], c1: [0.1107, 0.0454], c2: [0.1122, 0.0445] },
  { year: "2021", c0: [-0.0581, 0.0621], c1: [-0.0117, 0.0147], c2: [-0.0014, 0.0024] },
  { year: "2022", c0: [-0.0103, 0.0174], c1: [-0.0083, 0.0143], c2: [-0.0005, 0.0019] },
  { year: "2023", c0: [0.0027, 0.0293], c1: [0.0076, 0.0152], c2: [0.005, 0.0056] },
  { year: "2024", c0: [0.0201, 0.0059], c1: [0.0153, 0.0036], c2: [0.0029, 0.0035] },
  { year: "2025", c0: [0.0363, 0.0337], c1: [0.0057, 0.0073], c2: [-0.0001, 0.0002] },
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

// Config V1 bit-identique D3-P2 — seul regimePermissions varie.
const suiteConfig = (year: number) => ({
  runId: `regime-aware-${year}`,
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
});

type SuiteConfig = ReturnType<typeof suiteConfig>;

const ensembleStrategies = (config: SuiteConfig): readonly Strategy[] => {
  const size = (s: Strategy): Strategy =>
    withTargetSignalNotional(s, config.targetSignalNotional);
  const calibrate = (s: Strategy): Strategy =>
    withConfidenceCalibration(s, "IDENTITY");
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
  config: SuiteConfig,
  permissions: RegimePermissions | undefined,
): BacktestConfig => {
  const registry = createStrategyRegistry(ensembleStrategies(config));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  return {
    intervalMs: TIMEFRAME_MILLISECONDS["ONE_DAY"],
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
  config: SuiteConfig,
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

interface WindowMeasurement {
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
  readonly signalsPassed: number;
}

// Portes D3-P2 §10 (sans borne médiane) — miroir strict.
const isEligible = (m: WindowMeasurement): boolean =>
  m.maxDrawdown <= 0.1 && m.turnover <= 10 && m.feeRate <= 0.01 && m.signalsPassed > 0;

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
    const label = day.regime === null ? "warmUp" : day.regime;
    daysByRegime[label] = (daysByRegime[label] ?? 0) + 1;
  }
  daysByRegimeByYear.set(key(year), daysByRegime);
  console.log(
    `  jours régimes : ${Object.entries(daysByRegime).map(([r, n]) => `${r} ${n}`).join(" · ")}`,
  );

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
    const measurement: WindowMeasurement = {
      totalReturn: m.totalReturn,
      maxDrawdown: m.maxDrawdown,
      turnover: m.turnover,
      feeRate: m.grossTradedNotional > 0 ? m.fees / m.grossTradedNotional : 0,
      signalsPassed: replay.value.regimeGating?.signalsPassed ?? 0,
    };
    measurements.set(candidateKey, measurement);
    console.log(
      `  ${candidateKey} ret ${pct(m.totalReturn).padStart(7)} dd ${pct(m.maxDrawdown).padStart(6)} tover ${m.turnover.toFixed(2)} fee ${pct(measurement.feeRate)}`,
    );
  }
  byYear.set(key(year), measurements);
}

// WF3-R (1/2) — baselines V1 (C0).
console.log("\n== WF3-R (1/2) : baselines V1 (C0) ==");
let wf3Baselines = true;
for (const expected of WF3_EXPECTATIONS) {
  const m = byYear.get(expected.year)?.get("C0");
  if (m === undefined) {
    console.log(`${expected.year}: absent`);
    wf3Baselines = false;
    continue;
  }
  const matches =
    Math.abs(m.totalReturn - expected.ret) < 0.000_05 &&
    Math.abs(m.maxDrawdown - expected.dd) < 0.000_05;
  wf3Baselines = wf3Baselines && matches;
  console.log(
    `${expected.year}: ret ${pct(m.totalReturn)} (att. ${pct(expected.ret)}) dd ${pct(m.maxDrawdown)} (att. ${pct(expected.dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}

// WF3-R (2/2) — reproduction de la grille publiée D3-P2 §8.
console.log("\n== WF3-R (2/2) : reproduction grille D3-P2 publiée ==");
let gridOk = true;
for (const row of PUBLISHED_GRID) {
  const measurements = byYear.get(row.year);
  if (measurements === undefined) {
    console.log(`${row.year}: absente — reproduction non vérifiable`);
    gridOk = false;
    continue;
  }
  let rowOk = true;
  for (const [k, expected] of [
    ["C0", row.c0],
    ["C1", row.c1],
    ["C2", row.c2],
  ] as const) {
    const m = measurements.get(k)!;
    const match =
      Math.abs(m.totalReturn - expected[0]) < 0.000_1 &&
      Math.abs(m.maxDrawdown - expected[1]) < 0.000_1;
    rowOk = rowOk && match;
  }
  gridOk = gridOk && rowOk;
  console.log(`${row.year}: ${rowOk ? "OK" : "ÉCART"}`);
}
{
  const m2016 = byYear.get("2016")?.get("C0");
  if (m2016 === undefined) {
    console.log("2016: absent — contrôle D2-S non vérifiable");
    gridOk = false;
  } else {
    const match = Math.abs(m2016.totalReturn - 0.0235) < 0.000_1;
    gridOk = gridOk && match;
    console.log(`2016 (C0 vs D2-S +2,35 %): ret ${pct(m2016.totalReturn)} ${match ? "OK" : "ÉCART"}`);
  }
}
const wf3r = wf3Baselines && gridOk;
console.log(`WF3-R : ${wf3r ? "PASS" : "FAIL"}`);

// Sélections par fold : R-H2 vs argmax D3-P2.
console.log("\n== Sélections par train et folds ==");
const argmaxSelect = (
  measurements: ReadonlyMap<CandidateKey, WindowMeasurement>,
): { selected: CandidateKey; eligible: readonly CandidateKey[] } => {
  const eligible = CANDIDATE_KEYS.filter((k) => isEligible(measurements.get(k)!));
  if (eligible.length === 0) return { selected: "C0", eligible };
  const selected = eligible.reduce((best, k) =>
    measurements.get(k)!.totalReturn > measurements.get(best)!.totalReturn ? k : best,
  );
  return { selected, eligible };
};

// F = (BEARISH+RANGE)/(jours observés non-warmUp) du train (R-H2 §3).
const adverseFraction = (year: string): number | null => {
  const days = daysByRegimeByYear.get(year);
  if (days === undefined) return null;
  const observed = (days.BULLISH ?? 0) + (days.BEARISH ?? 0) + (days.RANGE ?? 0);
  if (observed === 0) return null;
  return ((days.BEARISH ?? 0) + (days.RANGE ?? 0)) / observed;
};

const rh2Select = (
  measurements: ReadonlyMap<CandidateKey, WindowMeasurement>,
  fraction: number | null,
): { selected: CandidateKey; c2Eligible: boolean } => {
  const c2Eligible = isEligible(measurements.get("C2")!);
  const selected: CandidateKey =
    c2Eligible && fraction !== null && fraction >= 0.5 ? "C2" : "C0";
  return { selected, c2Eligible };
};

interface Fold {
  readonly trainYear: number;
  readonly testYear: number;
  readonly clean: boolean;
  readonly rh2: CandidateKey;
  readonly argmax: CandidateKey;
  readonly fraction: number | null;
  readonly rh2TestReturn: number;
  readonly argmaxTestReturn: number;
  readonly c0TestReturn: number;
}
const folds: Fold[] = [];
let wiringOk = true;
for (let i = 0; i < START_YEARS.length - 1; i++) {
  const trainYear = START_YEARS[i]!;
  const testYear = START_YEARS[i + 1]!;
  if (unavailable.has(key(trainYear)) || unavailable.has(key(testYear))) continue;
  const train = byYear.get(key(trainYear))!;
  const test = byYear.get(key(testYear))!;
  const fraction = adverseFraction(key(trainYear));
  const rh2 = rh2Select(train, fraction);
  const argmax = argmaxSelect(train);
  // W1-r : câblage — C2 sélectionné ⇒ F ≥ 0,5 ∧ C2 éligible ; sinon C0.
  const wiring =
    (rh2.selected === "C2" && fraction !== null && fraction >= 0.5 && rh2.c2Eligible) ||
    rh2.selected === "C0";
  wiringOk = wiringOk && wiring;
  folds.push({
    trainYear,
    testYear,
    clean: !CONTAMINATED.has(key(trainYear)) && !CONTAMINATED.has(key(testYear)),
    rh2: rh2.selected,
    argmax: argmax.selected,
    fraction,
    rh2TestReturn: test.get(rh2.selected)!.totalReturn,
    argmaxTestReturn: test.get(argmax.selected)!.totalReturn,
    c0TestReturn: test.get("C0")!.totalReturn,
  });
  console.log(
    `train ${trainYear} (F=${fraction === null ? "n/a" : fraction.toFixed(2)}) | R-H2 → ${rh2.selected} · argmax → ${argmax.selected} | test ${testYear} ${CONTAMINATED.has(key(testYear)) ? "CONTAMINÉ" : "propre"} : R-H2 ${pct(test.get(rh2.selected)!.totalReturn)} vs argmax ${pct(test.get(argmax.selected)!.totalReturn)} vs C0 ${pct(test.get("C0")!.totalReturn)}`,
  );
}

// Critères a priori (folds propres).
console.log("\n== Critères a priori (folds propres) ==");
const cleanFolds = folds.filter((f) => f.clean);
console.log(`folds propres : ${cleanFolds.length}`);
const beatsArgmax = cleanFolds.filter((f) => f.rh2TestReturn > f.argmaxTestReturn).length;
const spreads = cleanFolds
  .map((f) => f.rh2TestReturn - f.argmaxTestReturn)
  .sort((a, b) => a - b);
const medianSpread =
  spreads.length % 2 === 1
    ? spreads[(spreads.length - 1) / 2]!
    : (spreads[spreads.length / 2 - 1]! + spreads[spreads.length / 2]!) / 2;
const beatsC0 = cleanFolds.filter((f) => f.rh2TestReturn > f.c0TestReturn).length;
const ddViolations = cleanFolds.filter((f) => {
  const m = byYear.get(key(f.testYear))!.get(f.rh2)!;
  return m.maxDrawdown > 0.1;
});
const requiredFolds = 4;
const w1r = wiringOk;
const w2r = beatsArgmax >= requiredFolds && medianSpread > 0;
const w3r = ddViolations.length === 0;
console.log(`W1-r câblage : ${w1r ? "PASS" : "FAIL"} (sélection ≡ règle sur ${folds.length} folds)`);
console.log(
  `W2-r transfert : R-H2 bat argmax sur ${beatsArgmax}/${cleanFolds.length} tests propres (≥4 requis), spread médian ${pct(medianSpread)} (>0 requis) → ${w2r ? "PASS" : "FAIL"} | info : bat always-C0 sur ${beatsC0}/${cleanFolds.length}`,
);
console.log(
  `W3-r sécurité : ${ddViolations.length} violation(s) dd > 10 % en test propre → ${w3r ? "PASS" : "FAIL"}`,
);

const verdict = w1r && w2r && w3r && wf3r;
console.log(
  `\nVERDICT H-P2 : ${verdict ? "VALIDÉ" : "DÉCLASSÉ"} (W1-r ${w1r ? "P" : "F"} · W2-r ${w2r ? "P" : "F"} · W3-r ${w3r ? "P" : "F"} · WF3-R ${wf3r ? "P" : "F"})`,
);
console.log(
  "Rappel §6 : un verdict VALIDÉ ne déploie rien — seule suite autorisée : réplication H-D1 sur produits jamais consultés.",
);
