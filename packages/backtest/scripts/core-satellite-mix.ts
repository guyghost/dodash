// Diagnostic M0 + H-CS1 — models/core-satellite-mix.md (pré-enregistré).
// 10 fenêtres annuelles BTC-USD ONE_DAY, 1 replay V1-IDENTITY par fenêtre,
// jambe holding miroir de benchmarkBuyAndHold (suite.ts), mix sans
// rééquilibrage mixEquity = w·hold + (1−w)·bot, w ∈ {0.25,0.5,0.75}
// (+ extrémités 0/1 en contrôle INV-CS3). Critères W-CS-A/B/C a priori.
// Exécution : node --experimental-strip-types scripts/core-satellite-mix.ts
// (depuis packages/backtest, après pnpm build).

import {
  calculateMetrics,
  loadCoinbaseHistoricalDataset,
  prepareBacktestIndicators,
  replayBacktest,
  withConfidenceCalibration,
  withTargetSignalNotional,
} from "@dodash/backtest";
import { createProductId, type Candle } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const START_YEARS: readonly number[] = [
  2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025,
];
const W_GRID: readonly number[] = [0.25, 0.5, 0.75];
const INITIAL_CAPITAL = 10_000;
const BROKER = Object.freeze({ feeBps: 6, slippageBps: 2 });

const DAY = 86_400_000;
const windowBounds = (year: number): { startAt: number; endAt: number } => {
  const startAt = Date.parse(`${year}-08-21T00:00:00Z`);
  const endAt = Date.parse(`${year + 1}-08-21T00:00:00Z`);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt % DAY !== 0 || endAt % DAY !== 0) {
    throw new Error(`unaligned window ${year}`);
  }
  return { startAt, endAt };
};

// Config V1 bit-identique D3-P2 (C0 : aucune regimePermissions).
const suiteConfig = (year: number) => ({
  runId: `core-satellite-${year}`,
  agentId: "dodash-backtest",
  initialCapital: INITIAL_CAPITAL,
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
  broker: BROKER,
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

// INV-CS1 — baselines V1 publiées (WF3-P miroir, tol 5e-5).
const WF_EXPECTATIONS: ReadonlyArray<{ year: number; ret: number; dd: number }> = [
  { year: 2023, ret: 0.0027, dd: 0.0293 },
  { year: 2025, ret: 0.0363, dd: 0.0337 },
];

// Jambe holding — miroir exact de benchmarkBuyAndHold (suite.ts) :
// achat au premier open, prix open×(1+slip), frais sur notional, close.
const holdingCurve = (
  candles: readonly Candle[],
  capital: number,
): ReadonlyArray<{ at: number; equity: number }> => {
  const first = candles[0];
  if (first === undefined) throw new Error("empty window");
  const executionPrice = first.open * (1 + BROKER.slippageBps / 10_000);
  const feeRate = BROKER.feeBps / 10_000;
  const quantity = capital / (executionPrice * (1 + feeRate));
  const fee = executionPrice * quantity * feeRate;
  const cash = capital - executionPrice * quantity - fee;
  return candles.map((c) => ({ at: c.start, equity: cash + quantity * c.close }));
};

const mixCurve = (
  hold: ReadonlyArray<{ at: number; equity: number }>,
  bot: ReadonlyArray<{ at: number; equity: number }>,
  w: number,
): ReadonlyArray<{ at: number; equity: number }> =>
  hold.map((h, i) => ({ at: h.at, equity: w * h.equity + (1 - w) * bot[i]!.equity }));

const curveMetrics = (curve: ReadonlyArray<{ at: number; equity: number }>) => {
  const m = calculateMetrics(curve, [], INITIAL_CAPITAL, 0);
  return { totalReturn: m.totalReturn, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe };
};

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

interface WindowRow {
  readonly year: number;
  readonly botM: { totalReturn: number; maxDrawdown: number; sharpe: number };
  readonly holdM: { totalReturn: number; maxDrawdown: number; sharpe: number };
  readonly mixes: ReadonlyMap<number, { totalReturn: number; maxDrawdown: number; sharpe: number }>;
}

const perWindow: WindowRow[] = [];
for (const year of START_YEARS) {
  const { startAt, endAt } = windowBounds(year);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) {
    console.log(`${year}: DONNÉES INDISPONIBLES (${dataset.error.code}) — fenêtre éliminée (INV-CS4)`);
    continue;
  }
  const candles = dataset.value.candles;
  const config = suiteConfig(year);
  const registry = createStrategyRegistry(ensembleStrategies(config));
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  const prepared = await prepareBacktestIndicators(candles, config.indicators);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const replay = await replayBacktest(
    candles,
    {
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
    },
    prepared.value,
  );
  if (!replay.ok) throw new Error(`${year}: ${JSON.stringify(replay.error)}`);

  const bot = replay.value.equityCurve;
  const hold = holdingCurve(candles, INITIAL_CAPITAL);
  // INV-CS2 — alignement bougie par bougie sur candle.start.
  if (bot.length !== candles.length || bot.some((p, i) => p.at !== candles[i]!.start)) {
    throw new Error(`${year}: courbe bot non alignée (${bot.length} vs ${candles.length})`);
  }
  // INV-CS3 — extrémités : mix(1) ≡ holding, mix(0) ≡ bot.
  const e1 = Math.max(
    ...mixCurve(hold, bot, 1).map((p, i) => Math.abs(p.equity - hold[i]!.equity)),
  );
  const e0 = Math.max(
    ...mixCurve(hold, bot, 0).map((p, i) => Math.abs(p.equity - bot[i]!.equity)),
  );
  if (e1 > 1e-6 || e0 > 1e-6) throw new Error(`${year}: contrôle extrémités FAIL (${e1}, ${e0})`);

  const botM = curveMetrics(bot);
  const holdM = curveMetrics(hold);
  const mixes = new Map(W_GRID.map((w) => [w, curveMetrics(mixCurve(hold, bot, w))]));
  perWindow.push({ year, botM, holdM, mixes });
  console.log(
    `${year}: holding ${pct(holdM.totalReturn).padStart(8)} dd ${pct(holdM.maxDrawdown).padStart(6)} | bot ${pct(botM.totalReturn).padStart(8)} dd ${pct(botM.maxDrawdown).padStart(6)} | ` +
      W_GRID.map((w) => `w${w} ${pct(mixes.get(w)!.totalReturn).padStart(8)}`).join(" "),
  );
}

// INV-CS1 — non-dérive V1.
console.log("\n== INV-CS1 : non-dérive (replay bot vs baselines V1) ==");
let inv1 = true;
for (const exp of WF_EXPECTATIONS) {
  const row = perWindow.find((r) => r.year === exp.year);
  if (row === undefined) {
    inv1 = false;
    console.log(`${exp.year}: absent`);
    continue;
  }
  const okRow =
    Math.abs(row.botM.totalReturn - exp.ret) < 5e-5 &&
    Math.abs(row.botM.maxDrawdown - exp.dd) < 5e-5;
  inv1 = inv1 && okRow;
  console.log(
    `${exp.year}: ret ${pct(row.botM.totalReturn)} (att. ${pct(exp.ret)}) dd ${pct(row.botM.maxDrawdown)} (att. ${pct(exp.dd)}) ${okRow ? "OK" : "ÉCART"}`,
  );
}
console.log(`INV-CS1 : ${inv1 ? "PASS" : "FAIL"}`);

// Agrégats et critères a priori (§6).
const geo = (rets: readonly number[]): number =>
  rets.reduce((acc, r) => acc * (1 + r), 1) ** (1 / rets.length) - 1;
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1
    ? s[(s.length - 1) / 2]!
    : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n== Agrégats (${perWindow.length} fenêtres) ==`);
const agg = (
  w: number,
): { w: number; G: number; DDworst: number; DDmed: number; calmar: number } => {
  const rets = perWindow.map((r) =>
    w === 1 ? r.holdM.totalReturn : w === 0 ? r.botM.totalReturn : r.mixes.get(w)!.totalReturn,
  );
  const dds = perWindow.map((r) =>
    w === 1 ? r.holdM.maxDrawdown : w === 0 ? r.botM.maxDrawdown : r.mixes.get(w)!.maxDrawdown,
  );
  const G = geo(rets);
  const DDworst = Math.max(...dds);
  return { w, G, DDworst, DDmed: median(dds), calmar: G / DDworst };
};
const rows = [agg(1), ...W_GRID.map(agg), agg(0)];
for (const r of rows) {
  console.log(
    `w=${r.w.toFixed(2)} : G ${pct(r.G).padStart(8)} DDworst ${pct(r.DDworst).padStart(6)} DDmed ${pct(r.DDmed).padStart(6)} Calmar ${(r.calmar * 100).toFixed(2)}`,
  );
}

console.log("\n== Critères W-CS a priori (vs w=1 holding) ==");
const holding = rows[0]!;
const admissible: typeof rows = [];
for (const r of rows.slice(1, -1)) {
  const A = r.calmar > holding.calmar;
  const B = r.DDworst <= 0.8 * holding.DDworst;
  const C = r.G >= 0.5 * holding.G;
  if (A && B && C) admissible.push(r);
  console.log(
    `w=${r.w.toFixed(2)} : A(calmar) ${A ? "PASS" : "FAIL"} (${(r.calmar * 100).toFixed(2)} vs ${(holding.calmar * 100).toFixed(2)}) | B(dd −20%) ${B ? "PASS" : "FAIL"} (${pct(r.DDworst)} vs seuil ${pct(0.8 * holding.DDworst)}) | C(G ≥ ½) ${C ? "PASS" : "FAIL"} (${pct(r.G)} vs seuil ${pct(0.5 * holding.G)})`,
  );
}
if (admissible.length > 0 && inv1) {
  const best = admissible.reduce((a, b) => (b.calmar > a.calmar + 1e-12 ? b : a.w < b.w ? a : b));
  console.log(`\nVERDICT H-CS1 : VALIDÉ — w* = ${best.w} (Calmar ${(best.calmar * 100).toFixed(2)})`);
} else {
  console.log(
    `\nVERDICT H-CS1 : ${inv1 ? "NON SOUTENU (aucun w ∈ grille passe A ∧ B ∧ C)" : `INVALIDE (INV-CS1 FAIL — la mesure dérive, verdict suspendu)`}`,
  );
}

// Détail par fenêtre pour le document (ret/dd par w).
console.log("\n== Détail par fenêtre (ret/dd) ==");
for (const r of perWindow) {
  console.log(
    `${r.year}: hold ${pct(r.holdM.totalReturn)}/${pct(r.holdM.maxDrawdown)} bot ${pct(r.botM.totalReturn)}/${pct(r.botM.maxDrawdown)} ` +
      W_GRID.map((w) => `w${w} ${pct(r.mixes.get(w)!.totalReturn)}/${pct(r.mixes.get(w)!.maxDrawdown)}`).join(" "),
  );
}
