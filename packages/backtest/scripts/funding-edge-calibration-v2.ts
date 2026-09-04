// Campagne DAO #35 — phase A : calibration du seuil d'entrée sur le
// dataset campagne-1 (dao30) UNIQUEMENT (models/funding-edge-campaign.md
// §A v2). Lecture-seule vis-à-vis du trading : ce script ne touche aucune
// permission, aucun code de production ; il relit les fixtures versionnées
// #30, dérive le seuil par la règle figée (rang le plus proche, p90 de
// |fundingAvg| SMA-72 causale sur les 294 jours de décision), rejoue la
// config §4 en in-sample et écrit l'annexe de calibration du protocole
// (models/funding-edge-campaign-v2.annexe-calibration.json). Aucune donnée
// postérieure au dataset campagne-1 n'est lue ici (INV-C1 v2 : la phase B
// ne collecte qu'après le commit du protocole).
// Exécution : npx tsx packages/backtest/scripts/funding-edge-calibration-v2.ts

import { readFile, writeFile } from "node:fs/promises";

import {
  createProductId,
  TIMEFRAME_MILLISECONDS,
  type Candle,
} from "@dodash/domain";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createFundingTrendStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  withTargetSignalNotional,
  type Strategy,
} from "@dodash/strategies";
import {
  computeIndicators,
  DEFAULT_INDICATOR_CONFIG,
  FUNDING_AVG_PERIOD,
} from "@dodash/indicators-prolog";

import { replayBacktest, type BacktestConfig } from "../src/replay.js";

// Fenêtre figée campagne-1 (models/funding-edge-campaign.md §2, inchangée).
const H12_START = Date.parse("2025-09-01T00:00:00Z");
const H12_END = Date.parse("2026-09-01T00:00:00Z");
const DAY = 86_400_000;
const SEGMENTS = [
  { id: "F1", startAt: Date.parse("2025-09-01T00:00:00Z"), endAt: Date.parse("2025-12-01T00:00:00Z") },
  { id: "F2", startAt: Date.parse("2025-12-01T00:00:00Z"), endAt: Date.parse("2026-03-01T00:00:00Z") },
  { id: "F3", startAt: Date.parse("2026-03-01T00:00:00Z"), endAt: Date.parse("2026-06-01T00:00:00Z") },
  { id: "F4", startAt: Date.parse("2026-06-01T00:00:00Z"), endAt: Date.parse("2026-09-01T00:00:00Z") },
  { id: "R30", startAt: Date.parse("2026-08-02T00:00:00Z"), endAt: Date.parse("2026-09-01T00:00:00Z") },
] as const;

// Règle de calibration figée (protocole §A) : quantile p90, méthode du
// rang le plus proche (h = ceil(p/100 × N), valeur au rang h, sans
// interpolation) sur |fundingAvg| des jours de décision in-sample.
const CALIBRATION_QUANTILE = 90;

// Config figée (§4 v1, reprise à l'identique — INV-C5).
const INITIAL_CAPITAL = 10_000;
const TARGET_SIGNAL_NOTIONAL = 1_000;
const RISK = Object.freeze({
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
});
const BROKER = Object.freeze({ feeBps: 6, slippageBps: 2 });

// Constantes de phase B, figées ICI (avant toute collecte out-of-sample)
// et re-vérifiées par le script de validation OOS contre cette annexe.
const PHASE_B = Object.freeze({
  // Début OOS = fin exacte du dataset campagne-1 (contiguïté).
  oosStartAt: H12_END,
  // Évaluabilité minimale (A0) : 90 bougies quotidiennes complètes — un
  // trimestre v1, la plus petite granularité de lecture de Sharpe du
  // protocole v1, et ≥ la période d'indicateur la plus longue (72).
  oosMinDays: 90,
  // Préfixe d'échauffement OOS : les 90 dernières bougies campagne-1,
  // état d'indicateurs uniquement (équité réinitialisée à l'entrée OOS).
  warmupPrefixDays: 90,
});

interface FixtureProvenance {
  readonly sha256: string;
}

const loadFixture = async <T>(
  dataPath: string,
  provenancePath: string,
): Promise<T> => {
  const bytes = await readFile(dataPath);
  const provenance = JSON.parse(
    await readFile(provenancePath, "utf8"),
  ) as FixtureProvenance;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 !== provenance.sha256) {
    throw new Error(`empreinte fixture invalide: ${dataPath}`);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
};

// Convention #27 (fundingRatesForCandles) : moyenne des taux observés dans
// [start, start + 24 h) de chaque bougie ; une bougie sans observation est
// une erreur (INV-C3).
const dailyRatesForCandles = (
  candles: readonly Candle[],
  samples: readonly { readonly time: number; readonly fundingRate: number }[],
): readonly number[] => {
  const rates: number[] = [];
  let cursor = 0;
  for (const candle of candles) {
    const end = candle.start + DAY;
    let sum = 0;
    let count = 0;
    while (cursor < samples.length) {
      const sample = samples[cursor];
      if (sample === undefined || sample.time >= end) break;
      if (sample.time >= candle.start) {
        sum += sample.fundingRate;
        count += 1;
      }
      cursor += 1;
    }
    if (count === 0) {
      throw new Error(`bougie ${candle.start} sans observation funding`);
    }
    rates.push(sum / count);
  }
  return rates;
};

// fundingAvg = SMA-72 causale (miroir de fundingInputFor/indicators.pl :
// suffixe de 72 bougies incluant la bougie courante), définie à partir de
// l'index FUNDING_AVG_PERIOD − 1.
const fundingAvgSeries = (
  rates: readonly number[],
): readonly (number | undefined)[] =>
  rates.map((_, index) =>
    index < FUNDING_AVG_PERIOD - 1
      ? undefined
      : rates.slice(index - FUNDING_AVG_PERIOD + 1, index + 1).reduce(
          (sum, value) => sum + value,
          0,
        ) / FUNDING_AVG_PERIOD,
  );

// Quantile par rang le plus proche : h = ceil(p/100 × N), valeur au rang
// h de la série triée croissante (pas d'interpolation — règle figée §A).
const nearestRankQuantile = (
  sorted: readonly number[],
  percentile: number,
): number => {
  if (sorted.length === 0) throw new Error("distribution vide");
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const value = sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
  if (value === undefined) throw new Error("rang hors distribution");
  return value;
};

interface SegmentMetrics {
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly trades: number;
}

// Conventions de segment figées (§5) : premier rendement incluant la
// jonction, drawdown relatif au pic local, trades par fill.executedAt,
// Sharpe annualisé √252 (écart-type n−1).
const segmentMetrics = (
  points: readonly { readonly at: number; readonly equity: number }[],
  trades: readonly { readonly fill: { readonly executedAt: number } }[],
  segment: { readonly startAt: number; readonly endAt: number },
  equityBefore: number,
): SegmentMetrics => {
  const inSegment = points.filter(
    (point) => point.at >= segment.startAt && point.at < segment.endAt,
  );
  const returns: number[] = [];
  let previous = equityBefore;
  for (const point of inSegment) {
    if (previous > 0) returns.push(point.equity / previous - 1);
    previous = point.equity;
  }
  const n = returns.length;
  const mean = n === 0 ? 0 : returns.reduce((sum, value) => sum + value, 0) / n;
  const variance =
    n < 2
      ? 0
      : returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const deviation = Math.sqrt(variance);
  const sharpe = deviation === 0 ? 0 : (mean / deviation) * Math.sqrt(252);
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of inSegment) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak === 0 ? 0 : (peak - point.equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }
  const trades_ = trades.filter(
    (trade) =>
      trade.fill.executedAt >= segment.startAt &&
      trade.fill.executedAt < segment.endAt,
  ).length;
  return Object.freeze({ sharpe, maxDrawdown, trades: trades_ });
};

const isoDate = (at: number): string => new Date(at).toISOString().slice(0, 10);

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("produit invalide");

const fundingFixture = await loadFixture<{
  readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
}>("packages/backtest/fixtures/dao30-funding-btc.json", "packages/backtest/fixtures/dao30-funding-btc.provenance.json");
const priceFixture = await loadFixture<{
  readonly candles: readonly Candle[];
}>("packages/backtest/fixtures/dao30-price-btc-usd.json", "packages/backtest/fixtures/dao30-price-btc-usd.provenance.json");

const candles = priceFixture.candles;
const fundingRates = dailyRatesForCandles(candles, fundingFixture.samples);
const fundingAvg = fundingAvgSeries(fundingRates);

// Phase A — distribution de |fundingAvg| sur les jours de décision.
const decisionDays = fundingAvg
  .map((value, index) => ({ value: value as number | undefined, index }))
  .filter((entry): entry is { value: number; index: number } => entry.value !== undefined);
const absAvg = decisionDays
  .map((entry) => Math.abs(entry.value))
  .sort((left, right) => left - right);
const enterThreshold = nearestRankQuantile(absAvg, CALIBRATION_QUANTILE);
const longCarryDays = decisionDays.filter(
  (entry) => entry.value <= -enterThreshold,
).length;
const shortCrowdingDays = decisionDays.filter(
  (entry) => entry.value >= enterThreshold,
).length;

// Signaux produits par la stratégie au seuil calibré (niveau stratégie,
// avant allocation) : rejeu indicateur bougie par bougie, miroir exact de
// replay.ts (computeIndicators + suffixe 72).
const fundingStrategyForSignals = createFundingTrendStrategy({
  enterThreshold,
  baseSize: TARGET_SIGNAL_NOTIONAL,
});
const decisionDistribution = [];
for (const entry of decisionDays) {
  const history = candles.slice(0, entry.index + 1);
  const indicators = await computeIndicators(
    history,
    DEFAULT_INDICATOR_CONFIG,
    undefined,
    {
      rates: fundingRates.slice(
        Math.max(0, history.length - FUNDING_AVG_PERIOD),
        history.length,
      ),
      avgPeriod: FUNDING_AVG_PERIOD,
    },
  );
  if (!indicators.ok) throw new Error(`indicateurs: ${indicators.error.code}`);
  const evaluated = fundingStrategyForSignals.evaluate({
    productId: product.value,
    candles: history,
    indicators: indicators.value,
    previousIndicators: null,
  });
  if (!evaluated.ok) throw new Error(`signal: ${evaluated.error.code}`);
  decisionDistribution.push({
    date: isoDate(candles[entry.index]!.start),
    fundingAvg: entry.value,
    signal: evaluated.value.side,
    raison: evaluated.value.reasonCode,
  });
}
const signalCounts = decisionDistribution.reduce<
  Record<string, number>
>((counts, entry) => {
  counts[entry.signal] = (counts[entry.signal] ?? 0) + 1;
  return counts;
}, {});

// Rejeu in-sample complet (config §4 identique v1, INV-C5) — la
// distribution PnL/Sharpe annexée au protocole.
const RUNS: readonly { readonly id: string; readonly strategy: Strategy }[] = [
  {
    id: "funding-trend",
    strategy: createFundingTrendStrategy({
      enterThreshold,
      baseSize: TARGET_SIGNAL_NOTIONAL,
    }),
  },
  {
    id: "rsi-reversion",
    strategy: createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: TARGET_SIGNAL_NOTIONAL,
    }),
  },
  {
    id: "ema-cross",
    strategy: createEmaCrossStrategy({ baseSize: TARGET_SIGNAL_NOTIONAL }),
  },
  {
    id: "breakout",
    strategy: createBreakoutStrategy({
      lookback: 20,
      baseSize: TARGET_SIGNAL_NOTIONAL,
    }),
  },
];

interface RunOutcome {
  readonly id: string;
  readonly h12: {
    readonly sharpe: number;
    readonly maxDrawdown: number;
    readonly trades: number;
    readonly fundingPaid: number;
    readonly pnl: number;
    readonly totalReturn: number;
    readonly turnover: number;
  };
  readonly segments: Readonly<Record<string, SegmentMetrics>>;
  readonly equityCurve: readonly { readonly at: number; readonly equity: number }[];
}

const outcomes: RunOutcome[] = [];
for (const run of RUNS) {
  const registry = createStrategyRegistry([
    withTargetSignalNotional(run.strategy, TARGET_SIGNAL_NOTIONAL),
  ]);
  if (!registry.ok) throw new Error(`registre invalide: ${run.id}`);
  const config: BacktestConfig = {
    intervalMs: TIMEFRAME_MILLISECONDS.ONE_DAY,
    runId: `dao35-calib:${run.id}`,
    agentId: "dodash-backtest",
    productId: product.value,
    initialCapital: INITIAL_CAPITAL,
    maxDecisionNotional: 2_000,
    minNetQuantity: 1e-6,
    indicators: DEFAULT_INDICATOR_CONFIG,
    strategies: registry.value,
    risk: RISK,
    broker: BROKER,
    fundingRates,
  };
  const replay = await replayBacktest(candles, config);
  if (!replay.ok) throw new Error(`replay ${run.id}: ${replay.error.code}`);
  const { metrics, equityCurve, trades } = replay.value;
  const segments: Record<string, SegmentMetrics> = {};
  for (const segment of SEGMENTS) {
    const before = equityCurve.findLast((point) => point.at < segment.startAt);
    segments[segment.id] = segmentMetrics(
      equityCurve,
      trades,
      segment,
      before?.equity ?? INITIAL_CAPITAL,
    );
  }
  outcomes.push({
    id: run.id,
    h12: {
      sharpe: metrics.sharpe,
      maxDrawdown: metrics.maxDrawdown,
      trades: trades.length,
      fundingPaid: replay.value.fundingPaid,
      pnl: metrics.pnl,
      totalReturn: metrics.totalReturn,
      turnover: metrics.turnover,
    },
    segments,
    equityCurve,
  });
}

// Distribution complète des rendements journaliers de funding-trend
// (jours de décision, jonction incluse) — annexée au protocole (§A).
const fundingOutcome = outcomes.find((outcome) => outcome.id === "funding-trend");
if (fundingOutcome === undefined) throw new Error("run funding-trend absent");
const decisionReturns = decisionDays.map((entry) => {
  const at = candles[entry.index]!.start;
  const equity = fundingOutcome.equityCurve.find((point) => point.at === at);
  const before = fundingOutcome.equityCurve.findLast(
    (point) => point.at < at,
  );
  const previous = before?.equity ?? INITIAL_CAPITAL;
  return {
    date: isoDate(at),
    rendement: equity !== undefined && previous > 0 ? equity.equity / previous - 1 : 0,
    equite: equity?.equity ?? null,
  };
});

const benchmarkTotalReturn = (() => {
  const first = candles[0];
  const last = candles.at(-1);
  if (first === undefined || last === undefined) return null;
  const executionPrice = first.open * (1 + BROKER.slippageBps / 10_000);
  const feeRate = BROKER.feeBps / 10_000;
  const quantity = INITIAL_CAPITAL / (executionPrice * (1 + feeRate));
  const finalEquity = quantity * last.close;
  return finalEquity / INITIAL_CAPITAL - 1;
})();

const annex = {
  protocole: "models/funding-edge-campaign.md §A (v2, DAO #35)",
  phase: "A — calibration in-sample (dataset campagne-1 exclusivement)",
  dataset: {
    funding: {
      fichier: "packages/backtest/fixtures/dao30-funding-btc.json",
      sha256: JSON.parse(
        await readFile("packages/backtest/fixtures/dao30-funding-btc.provenance.json", "utf8"),
      ).sha256,
    },
    prix: {
      fichier: "packages/backtest/fixtures/dao30-price-btc-usd.json",
      sha256: JSON.parse(
        await readFile("packages/backtest/fixtures/dao30-price-btc-usd.provenance.json", "utf8"),
      ).sha256,
    },
    fenetre: { startAt: H12_START, endAt: H12_END },
  },
  regleCalibration: {
    quantite: "|fundingAvg| — SMA 72 jours causale (FUNDING_AVG_PERIOD, suffixe aligné bougies)",
    joursDeDecision: decisionDays.length,
    methode: "rang le plus proche : h = ceil(p/100 × N), valeur au rang h de la série triée, sans interpolation",
    quantile: CALIBRATION_QUANTILE,
  },
  seuilEntree: { valeur: enterThreshold, joursTraverses: longCarryDays + shortCrowdingDays, joursLongCarry: longCarryDays, joursShortCrowding: shortCrowdingDays },
  distributionAbsFundingAvg: {
    min: absAvg[0],
    p50: nearestRankQuantile(absAvg, 50),
    p75: nearestRankQuantile(absAvg, 75),
    p90: nearestRankQuantile(absAvg, 90),
    p95: nearestRankQuantile(absAvg, 95),
    p99: nearestRankQuantile(absAvg, 99),
    max: absAvg.at(-1),
  },
  distributionSignaux: signalCounts,
  distributionDecision: decisionDistribution.map((entry, index) => ({
    ...entry,
    ...decisionReturns[index],
  })),
  rejeuInSample: {
    config: {
      produit: "BTC-USD",
      timeframe: "ONE_DAY",
      capitalInitial: INITIAL_CAPITAL,
      notionalSignal: TARGET_SIGNAL_NOTIONAL,
      risque: RISK,
      broker: BROKER,
      indicators: "DEFAULT_INDICATOR_CONFIG",
      protectiveExit: "NONE",
      regimeFilter: "absent",
      calibration: "IDENTITY",
    },
    runs: outcomes.map((outcome) => ({
      id: outcome.id,
      h12: outcome.h12,
      segments: outcome.segments,
    })),
    benchmarkBuyAndHold: { totalReturn: benchmarkTotalReturn },
  },
  constantesPhaseB: {
    oosStartAt: PHASE_B.oosStartAt,
    oosMinDays: PHASE_B.oosMinDays,
    warmupPrefixDays: PHASE_B.warmupPrefixDays,
    grille: {
      A1: "sharpeOOS(funding-trend) >= max(sharpeOOS legacy) + 0.25",
      A2: "tradesOOS(funding-trend) >= ceil(30 × joursOOS / 365)",
      A3: "drawdownOOS(funding-trend) <= max(drawdownOOS legacy) + 0.05",
      A4: "sharpeOOS(funding-trend) >= 0",
      verdict: "A1 ∧ A2 ∧ A3 ∧ A4 (évalué uniquement si A0 — fenêtre OOS >= 90 jours)",
    },
  },
};

const annexPath = "models/funding-edge-campaign-v2.annexe-calibration.json";
const annexBytes = new TextEncoder().encode(`${JSON.stringify(annex, null, 2)}\n`);
await writeFile(annexPath, annexBytes);

console.log(JSON.stringify({
  statut: "CALIBRE",
  seuilEntree: enterThreshold,
  joursDeDecision: decisionDays.length,
  joursTraverses: { longCarry: longCarryDays, shortCrowding: shortCrowdingDays },
  distributionSignaux: signalCounts,
  inSample: {
    fundingTrend: fundingOutcome.h12,
    baselineMax: Math.max(
      ...outcomes.filter((outcome) => outcome.id !== "funding-trend").map((outcome) => outcome.h12.sharpe),
    ),
  },
  annexe: annexPath,
  annexeSha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", annexBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(""),
  constantesPhaseB: PHASE_B,
}, null, 2));
