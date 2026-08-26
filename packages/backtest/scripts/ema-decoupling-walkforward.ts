// Walk-forward H-S1a — models/ema-signal-decoupling.md (pré-enregistré).
// 10 fenêtres BTC × {E0 défaut, E1 signalEma 5/13}, config V1 bit-identique
// D3-P2 par ailleurs. WF3-E : E0 reproduit les baselines V1. Contrôle
// d'effet : solo ema E1 ≥ 1 fill clôturé sur ≥ 1 fenêtre (inertie brisée) ;
// ensemble : signalsPassed/denied diffèrent entre E0 et E1. Sélection par
// train : portes D3-P2 (dd ≤ 10 %, turnover ≤ 10, feeRate ≤ 1 %,
// signalsPassed > 0) + argmax return, défaut E0. Critères W1-E/W2-E/W3-E
// sur 6 folds propres (hors {2023, 2025}).
// Exécution : node --experimental-strip-types scripts/ema-decoupling-walkforward.ts
// (depuis packages/backtest, après pnpm build).

import {
  loadCoinbaseHistoricalDataset,
  prepareBacktestIndicators,
  replayBacktest,
  withConfidenceCalibration,
  withTargetSignalNotional,
  type BacktestConfig,
} from "@dodash/backtest";
import { createProductId, type Candle, type Strategy } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG, type IndicatorConfig } from "@dodash/indicators-prolog";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
} from "@dodash/strategies";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

type CandidateKey = "E0" | "E1";
const CANDIDATE_KEYS: readonly CandidateKey[] = ["E0", "E1"];

// E0 : champs absents (INV-E1 bit-exact V1). E1 : paire de signal 5/13.
const indicatorsFor = (key: CandidateKey): IndicatorConfig =>
  key === "E0"
    ? DEFAULT_INDICATOR_CONFIG
    : {
        ...DEFAULT_INDICATOR_CONFIG,
        signalEmaFastPeriod: 5,
        signalEmaSlowPeriod: 13,
      };

const START_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const CONTAMINATED = new Set(["2023", "2025"]);

// WF3-E — baselines V1 publiées (tol 5e-5, miroir WF3-P/WF3-R).
const WF3_EXPECTATIONS: ReadonlyArray<{ year: string; ret: number; dd: number }> = [
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

const baseConfig = (year: number) => ({
  runId: `ema-decoupling-${year}`,
  agentId: "dodash-backtest",
  initialCapital: 10_000,
  maxDecisionNotional: 2_000,
  minNetQuantity: 0.000_001,
  targetSignalNotional: 1_000,
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

type BaseConfig = ReturnType<typeof baseConfig>;

// Ensemble miroir D3-P2 (calibration IDENTITY, sizing notional).
const ensembleStrategies = (config: BaseConfig): readonly Strategy[] => {
  const size = (s: Strategy): Strategy => withTargetSignalNotional(s, config.targetSignalNotional);
  const calibrate = (s: Strategy): Strategy => withConfidenceCalibration(s, "IDENTITY");
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
        createBreakoutStrategy({ lookback: 20, baseSize: config.targetSignalNotional }),
      ),
    ),
  ];
};

// Solo ema-cross (contrôle d'inertie §6.1) — même décorateur que l'ensemble.
const soloEmaStrategies = (config: BaseConfig): readonly Strategy[] => {
  const size = (s: Strategy): Strategy => withTargetSignalNotional(s, config.targetSignalNotional);
  const calibrate = (s: Strategy): Strategy => withConfidenceCalibration(s, "IDENTITY");
  return [size(calibrate(createEmaCrossStrategy({ baseSize: config.targetSignalNotional })))];
};

const replayConfigFor = (
  config: BaseConfig,
  indicators: IndicatorConfig,
  strategies: readonly Strategy[],
  suffix: string,
): BacktestConfig => {
  const registry = createStrategyRegistry(strategies);
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  return {
    runId: `${config.runId}:${suffix}`,
    agentId: config.agentId,
    productId: product.value,
    initialCapital: config.initialCapital,
    maxDecisionNotional: config.maxDecisionNotional,
    minNetQuantity: config.minNetQuantity,
    indicators,
    strategies: registry.value,
    risk: config.risk,
    broker: config.broker,
    protectiveExit: config.protectiveExit,
    regimeFilter: config.regimeFilter,
  };
};

interface Measurement {
  readonly totalReturn: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
  readonly signalsPassed: number;
  readonly deniedEma: number;
  readonly trades: number;
  readonly closedTrades: number;
}

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const key = (year: number): string => `${year}`;

// Portes D3-P2 §10 (sans borne médiane).
const isEligible = (m: Measurement): boolean =>
  m.maxDrawdown <= 0.1 && m.turnover <= 10 && m.feeRate <= 0.01 && m.signalsPassed > 0;

const byYear = new Map<string, Map<CandidateKey, Measurement>>();
const soloByYear = new Map<string, Map<CandidateKey, Measurement>>();
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

  const config = baseConfig(year);
  const measurements = new Map<CandidateKey, Measurement>();
  const solos = new Map<CandidateKey, Measurement>();

  for (const candidateKey of CANDIDATE_KEYS) {
    const indicators = indicatorsFor(candidateKey);
    const prepared = await prepareBacktestIndicators(candles, indicators);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));

    // Ensemble (critères).
    const ensembleReplay = await replayBacktest(
      candles,
      replayConfigFor(config, indicators, ensembleStrategies(config), `ensemble-${candidateKey}`),
      prepared.value,
    );
    if (!ensembleReplay.ok) {
      throw new Error(`${year}/${candidateKey}: ${JSON.stringify(ensembleReplay.error)}`);
    }
    const m = ensembleReplay.value.metrics;
    measurements.set(candidateKey, {
      totalReturn: m.totalReturn,
      maxDrawdown: m.maxDrawdown,
      turnover: m.turnover,
      feeRate: m.grossTradedNotional > 0 ? m.fees / m.grossTradedNotional : 0,
      signalsPassed: ensembleReplay.value.regimeGating?.signalsPassed ?? 0,
      deniedEma: ensembleReplay.value.regimeGating?.deniedByStrategy["ema-cross"] ?? 0,
      trades: ensembleReplay.value.trades.length,
      closedTrades: ensembleReplay.value.trades.filter((t) => t.closedQuantity > 0).length,
    });

    // Solo ema (contrôle d'inertie — mesure secondaire).
    const soloReplay = await replayBacktest(
      candles,
      replayConfigFor(config, indicators, soloEmaStrategies(config), `solo-ema-${candidateKey}`),
      prepared.value,
    );
    if (!soloReplay.ok) {
      throw new Error(`${year}/${candidateKey}/solo: ${JSON.stringify(soloReplay.error)}`);
    }
    const sm = soloReplay.value.metrics;
    solos.set(candidateKey, {
      totalReturn: sm.totalReturn,
      maxDrawdown: sm.maxDrawdown,
      turnover: sm.turnover,
      feeRate: 0,
      signalsPassed: soloReplay.value.regimeGating?.signalsPassed ?? 0,
      deniedEma: soloReplay.value.regimeGating?.deniedByStrategy["ema-cross"] ?? 0,
      trades: soloReplay.value.trades.length,
      closedTrades: soloReplay.value.trades.filter((t) => t.closedQuantity > 0).length,
    });

    const ens = measurements.get(candidateKey)!;
    const solo = solos.get(candidateKey)!;
    console.log(
      `  ${candidateKey} ens ret ${pct(ens.totalReturn).padStart(7)} dd ${pct(ens.maxDrawdown).padStart(6)} tover ${ens.turnover.toFixed(2)} passed ${ens.signalsPassed} deniedEma ${ens.deniedEma} trades ${ens.closedTrades} | solo ema ret ${pct(solo.totalReturn).padStart(7)} fills ${solo.trades} clôturés ${solo.closedTrades}`,
    );
  }
  byYear.set(key(year), measurements);
  soloByYear.set(key(year), solos);
}

// WF3-E — non-dérive (E0 ≡ V1).
console.log("\n== WF3-E : non-dérive (E0 vs baselines V1) ==");
let wf3e = true;
for (const expected of WF3_EXPECTATIONS) {
  const m = byYear.get(expected.year)?.get("E0");
  if (m === undefined) {
    console.log(`${expected.year}: absent`);
    wf3e = false;
    continue;
  }
  const matches =
    Math.abs(m.totalReturn - expected.ret) < 0.000_05 &&
    Math.abs(m.maxDrawdown - expected.dd) < 0.000_05;
  wf3e = wf3e && matches;
  console.log(
    `${expected.year}: ret ${pct(m.totalReturn)} (att. ${pct(expected.ret)}) dd ${pct(m.maxDrawdown)} (att. ${pct(expected.dd)}) ${matches ? "OK" : "ÉCART"}`,
  );
}
console.log(`WF3-E : ${wf3e ? "PASS" : "FAIL"}`);

// Contrôle d'effet §6.
console.log("\n== Contrôle d'effet ==");
let inertiaBroken = false;
let policyBites = false;
for (const year of START_YEARS) {
  const solos = soloByYear.get(key(year));
  const measurements = byYear.get(key(year));
  if (solos === undefined || measurements === undefined) continue;
  const soloE1 = solos.get("E1")!;
  const ensE0 = measurements.get("E0")!;
  const ensE1 = measurements.get("E1")!;
  if (soloE1.trades > 0) inertiaBroken = true;
  if (
    ensE1.signalsPassed !== ensE0.signalsPassed ||
    ensE1.deniedEma !== ensE0.deniedEma
  ) {
    policyBites = true;
  }
  console.log(
    `${year}: solo E1 fills ${soloE1.trades} (clôturés ${soloE1.closedTrades}) | ensemble passed ${ensE0.signalsPassed}→${ensE1.signalsPassed} deniedEma ${ensE0.deniedEma}→${ensE1.deniedEma}`,
  );
}
const soloE0Inert = [...soloByYear.values()].every((s) => (s.get("E0")?.trades ?? 0) === 0);
console.log(
  `Inertie E0 confirmée (solo zéro fill partout) : ${soloE0Inert ? "OUI" : "NON — écart à documenter"}`,
);
console.log(
  `Effet 1 (inertie brisée E1, ≥ 1 fill) : ${inertiaBroken ? "PASS" : "FAIL"} | Effet 2 (la policy mord en ensemble) : ${policyBites ? "PASS" : "FAIL"}`,
);
const effectOk = inertiaBroken && policyBites;

// Sélection par fold.
console.log("\n== Sélections par train et folds ==");
const selectOnTrain = (
  measurements: ReadonlyMap<CandidateKey, Measurement>,
): { selected: CandidateKey; eligible: readonly CandidateKey[] } => {
  const eligible = CANDIDATE_KEYS.filter((k) => isEligible(measurements.get(k)!));
  if (eligible.length === 0) return { selected: "E0", eligible };
  const selected = eligible.reduce((best, k) =>
    measurements.get(k)!.totalReturn > measurements.get(best)!.totalReturn ? k : best,
  );
  return { selected, eligible };
};

interface Fold {
  readonly trainYear: number;
  readonly testYear: number;
  readonly clean: boolean;
  readonly selected: CandidateKey;
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
    clean: !CONTAMINATED.has(key(trainYear)) && !CONTAMINATED.has(key(testYear)),
    selected,
    selectedTestReturn: test.get(selected)!.totalReturn,
    defaultTestReturn: test.get("E0")!.totalReturn,
  });
  console.log(
    `train ${trainYear} éligibles [${eligible.join(", ") || "aucun"}] → ${selected} | test ${testYear} ${CONTAMINATED.has(key(testYear)) ? "CONTAMINÉ" : "propre"} : ${selected} ${pct(test.get(selected)!.totalReturn)} vs E0 ${pct(test.get("E0")!.totalReturn)} ${test.get(selected)!.totalReturn > test.get("E0")!.totalReturn ? "→ bat" : "→ ne bat pas"}`,
  );
}

// Critères a priori (folds propres).
console.log("\n== Critères a priori (folds propres) ==");
const cleanFolds = folds.filter((f) => f.clean);
console.log(`folds propres : ${cleanFolds.length}`);
const e1Selected = cleanFolds.filter((f) => f.selected === "E1").length;
const beats = cleanFolds.filter((f) => f.selectedTestReturn > f.defaultTestReturn).length;
const spreads = cleanFolds
  .map((f) => f.selectedTestReturn - f.defaultTestReturn)
  .sort((a, b) => a - b);
const medianSpread =
  spreads.length % 2 === 1
    ? spreads[(spreads.length - 1) / 2]!
    : (spreads[spreads.length / 2 - 1]! + spreads[spreads.length / 2]!) / 2;
const ddViolations = cleanFolds.filter((f) => {
  const m = byYear.get(key(f.testYear))!.get(f.selected)!;
  return m.maxDrawdown > 0.1;
});
const requiredFolds = 4;
const w1e = e1Selected >= requiredFolds;
const w2e = beats >= requiredFolds && medianSpread > 0;
const w3e = ddViolations.length === 0;
console.log(
  `W1-E stabilité : E1 sélectionné sur ${e1Selected}/${cleanFolds.length} trains propres (≥4 requis) → ${w1e ? "PASS" : "FAIL"}`,
);
console.log(
  `W2-E OOS : sélectionné bat E0 sur ${beats}/${cleanFolds.length} tests propres (≥4 requis), spread médian ${pct(medianSpread)} (>0 requis) → ${w2e ? "PASS" : "FAIL"}`,
);
console.log(
  `W3-E sécurité : ${ddViolations.length} violation(s) dd > 10 % en test propre → ${w3e ? "PASS" : "FAIL"}`,
);

const verdict = w1e && w2e && w3e && wf3e && effectOk;
console.log(
  `\nVERDICT H-S1a : ${verdict ? "VALIDÉ" : "DÉCLASSÉ"} (W1-E ${w1e ? "P" : "F"} · W2-E ${w2e ? "P" : "F"} · W3-E ${w3e ? "P" : "F"} · WF3-E ${wf3e ? "P" : "F"} · effet ${effectOk ? "P" : "F"})`,
);
if (verdict) {
  console.log(
    "Rappel §8 : VALIDÉ ne déploie rien — seule suite autorisée : H-D2 (produits jamais consultés et non brûlés par H-D1).",
  );
} else {
  console.log(
    "H-S0 retenue → le levier découplage est fermé ; plus de candidat pré-enregistré en branche 4 (K3 : arrêt de la recherche d'edge V1).",
  );
}

// Détail solo par fenêtre (mesure secondaire consignée §6).
console.log("\n== Détail solo ema par fenêtre (ret / fills / clôturés) ==");
for (const year of START_YEARS) {
  const solos = soloByYear.get(key(year));
  if (solos === undefined) continue;
  const e0 = solos.get("E0")!;
  const e1 = solos.get("E1")!;
  console.log(
    `${year}: E0 ${pct(e0.totalReturn).padStart(7)} fills ${e0.trades} | E1 ${pct(e1.totalReturn).padStart(7)} fills ${e1.trades} clôturés ${e1.closedTrades} passed ${e1.signalsPassed} denied ${e1.deniedEma}`,
  );
}
