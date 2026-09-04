// Campagne DAO #35 — phase B : rejeu out-of-sample et verdict mécanique
// (models/funding-edge-campaign.md §B v2). Lecture-seule : aucune
// permission, aucun code de trading. Le rejeu concatène un préfixe
// d'échauffement (90 dernières bougies campagne-1, état d'indicateurs
// uniquement) et la fenêtre OOS collectée après le commit du protocole ;
// les métriques et la grille A0–A4 ne portent que sur la fenêtre OOS.
// INV-C7 (itération unique) : ce script évalue la grille pré-enregistrée
// telle quelle — aucun recalibrage, aucune retouche de seuil.
// Exécution : npx tsx packages/backtest/scripts/funding-edge-oos-v2.ts

import { readFile } from "node:fs/promises";

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
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";

import { replayBacktest, type BacktestConfig } from "../src/replay.js";

// Seuil calibré phase A (annexe figée au commit du protocole) — la valeur
// est re-vérifiée contre l'annexe à l'exécution (tout écart est fatal).
const ENTER_THRESHOLD = 0.000010120617245370372;
const DAY = 86_400_000;

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

// Conventions de segment figées (§5) : premier rendement incluant la
// jonction, drawdown relatif au pic local du segment, trades par
// fill.executedAt, Sharpe segment annualisé √252 (écart-type n−1).
const segmentMetrics = (
  points: readonly { readonly at: number; readonly equity: number }[],
  trades: readonly { readonly fill: { readonly executedAt: number } }[],
  segment: { readonly startAt: number; readonly endAt: number },
  equityBefore: number,
): {
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly trades: number;
} => {
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

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("produit invalide");

// Annexe de calibration (source de vérité du seuil et des constantes B).
const annex = JSON.parse(
  await readFile("models/funding-edge-campaign-v2.annexe-calibration.json", "utf8"),
) as {
  seuilEntree: { readonly valeur: number };
  constantesPhaseB: {
    readonly oosStartAt: number;
    readonly oosMinDays: number;
    readonly warmupPrefixDays: number;
  };
};
if (annex.seuilEntree.valeur !== ENTER_THRESHOLD) {
  throw new Error(
    "seuil de l'annexe différent du seuil implémenté — arrêt (INV-C7)",
  );
}
const { oosMinDays, warmupPrefixDays } = annex.constantesPhaseB;

// Préfixe d'échauffement : dernières bougies campagne-1 (état indicateurs).
const inSamplePrice = await loadFixture<{ readonly candles: readonly Candle[] }>(
  "packages/backtest/fixtures/dao30-price-btc-usd.json",
  "packages/backtest/fixtures/dao30-price-btc-usd.provenance.json",
);
const inSampleFunding = await loadFixture<{
  readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
}>("packages/backtest/fixtures/dao30-funding-btc.json", "packages/backtest/fixtures/dao30-funding-btc.provenance.json");
const inSampleRates = dailyRatesForCandles(
  inSamplePrice.candles,
  inSampleFunding.samples,
);

// Fenêtre OOS collectée APRÈS le commit du protocole (INV-C1).
const oosPrice = await loadFixture<{
  readonly startAt: number;
  readonly endAt: number;
  readonly candles: readonly Candle[];
}>("packages/backtest/fixtures/dao35-price-btc-usd-oos.json", "packages/backtest/fixtures/dao35-price-btc-usd-oos.provenance.json");
const oosFunding = await loadFixture<{
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
}>("packages/backtest/fixtures/dao35-funding-btc-oos.json", "packages/backtest/fixtures/dao35-funding-btc-oos.provenance.json");

const oosCandles = oosPrice.candles;
const oosStartAt = oosFunding.startTime;
const oosEndAt = oosFunding.endTime;
if (oosPrice.startAt !== oosStartAt || oosPrice.endAt !== oosEndAt) {
  throw new Error("fenêtres fixtures prix/funding OOS désalignées");
}
if (
  oosCandles.length !== (oosEndAt - oosStartAt) / DAY ||
  oosCandles.some((candle, index) => candle.start !== oosStartAt + index * DAY)
) {
  throw new Error("couverture bougies OOS incomplète");
}
const oosRates = dailyRatesForCandles(oosCandles, oosFunding.samples);
if (oosRates.length !== oosCandles.length) {
  throw new Error("série de coût OOS désalignée des bougies");
}

// A0 — évaluabilité mécanique (constante figée en phase A).
const evaluabilite = oosCandles.length >= oosMinDays;

if (!evaluabilite) {
  // État EN ATTENTE (INV-C3) : protocole + scripts prêts, aucun verdict.
  console.log(
    JSON.stringify(
      {
        protocol: "models/funding-edge-campaign.md §B (v2, DAO #35)",
        verdict: "EN_ATTENTE_FENETRE_INSUFFISANTE",
        A0: {
          satisfait: false,
          joursOos: oosCandles.length,
          joursRequis: oosMinDays,
          fenetre: { startAt: oosStartAt, endAt: oosEndAt },
        },
        grille: null,
        note: "Fenêtre OOS trop courte pour un verdict — la grille A1–A4 n'est pas évaluée (itération unique préservée : elle le sera une fois, sur la première fenêtre atteignant A0).",
      },
      null,
      2,
    ),
  );
} else {
  // Rejeu concaténé : préfixe d'échauffement + fenêtre OOS. Équité
  // initiale 10 000 au début du préfixe ; les runs entrent dans OOS avec
  // l'état (position, équité) issu du préfixe — miroir d'un passage live.
  const prefixCount = warmupPrefixDays;
  const prefixCandles = inSamplePrice.candles.slice(-prefixCount);
  const prefixRates = inSampleRates.slice(-prefixCount);
  const allCandles = [...prefixCandles, ...oosCandles];
  const allRates = [...prefixRates, ...oosRates];

  const RUNS: readonly { readonly id: string; readonly strategy: Strategy }[] = [
    {
      id: "funding-trend",
      strategy: createFundingTrendStrategy({
        enterThreshold: ENTER_THRESHOLD,
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

  const oosSegment = { startAt: oosStartAt, endAt: oosEndAt };
  const outcomes = [];
  for (const run of RUNS) {
    const registry = createStrategyRegistry([
      withTargetSignalNotional(run.strategy, TARGET_SIGNAL_NOTIONAL),
    ]);
    if (!registry.ok) throw new Error(`registre invalide: ${run.id}`);
    const config: BacktestConfig = {
      intervalMs: TIMEFRAME_MILLISECONDS.ONE_DAY,
      runId: `dao35-oos:${run.id}`,
      agentId: "dodash-backtest",
      productId: product.value,
      initialCapital: INITIAL_CAPITAL,
      maxDecisionNotional: 2_000,
      minNetQuantity: 1e-6,
      indicators: DEFAULT_INDICATOR_CONFIG,
      strategies: registry.value,
      risk: RISK,
      broker: BROKER,
      fundingRates: allRates,
    };
    const replay = await replayBacktest(allCandles, config);
    if (!replay.ok) throw new Error(`replay ${run.id}: ${replay.error.code}`);
    const { equityCurve, trades } = replay.value;
    const before = equityCurve.findLast((point) => point.at < oosStartAt);
    outcomes.push({
      id: run.id,
      oos: segmentMetrics(equityCurve, trades, oosSegment, before?.equity ?? INITIAL_CAPITAL),
      // Indicatif, hors grille : coût de funding sur le span complet
      // (préfixe + OOS), non imputable par segment dans le cœur de rejeu.
      fundingPaidSpanComplet: replay.value.fundingPaid,
    });
  }

  const fundingRun = outcomes.find((outcome) => outcome.id === "funding-trend");
  const legacy = outcomes.filter((outcome) => outcome.id !== "funding-trend");
  if (fundingRun === undefined || legacy.length !== 3) {
    throw new Error("runs attendus absents");
  }
  const baselineMaxSharpe = Math.max(...legacy.map((outcome) => outcome.oos.sharpe));
  const baselineMaxDrawdown = Math.max(...legacy.map((outcome) => outcome.oos.maxDrawdown));
  const baselineMaxId = legacy.find((outcome) => outcome.oos.sharpe === baselineMaxSharpe)?.id;
  const joursOos = oosCandles.length;
  const seuilA2 = Math.ceil((30 * joursOos) / 365);

  // Grille mécanique figée en phase A (§B) — évaluée une seule fois.
  const grille = {
    A1_edgeNet: {
      seuil: "sharpeOOS(funding-trend) >= max(sharpeOOS legacy) + 0.25",
      valeur: fundingRun.oos.sharpe - baselineMaxSharpe,
      satisfait: fundingRun.oos.sharpe >= baselineMaxSharpe + 0.25,
    },
    A2_activite: {
      seuil: `tradesOOS(funding-trend) >= ceil(30 × ${joursOos} / 365) = ${seuilA2}`,
      valeur: fundingRun.oos.trades,
      satisfait: fundingRun.oos.trades >= seuilA2,
    },
    A3_risque: {
      seuil: "drawdownOOS(funding-trend) <= max(drawdownOOS legacy) + 0.05",
      valeur: fundingRun.oos.maxDrawdown - baselineMaxDrawdown,
      satisfait: fundingRun.oos.maxDrawdown <= baselineMaxDrawdown + 0.05,
    },
    A4_nonDestructif: {
      seuil: "sharpeOOS(funding-trend) >= 0",
      valeur: fundingRun.oos.sharpe,
      satisfait: fundingRun.oos.sharpe >= 0,
    },
  };
  const verdict =
    grille.A1_edgeNet.satisfait &&
    grille.A2_activite.satisfait &&
    grille.A3_risque.satisfait &&
    grille.A4_nonDestructif.satisfait
      ? "VALIDE"
      : "ECHOUE";

  // Benchmark buy-and-hold sur la fenêtre OOS seule (formule de la suite).
  const first = oosCandles[0];
  const last = oosCandles.at(-1);
  const benchmark = (() => {
    if (first === undefined || last === undefined) return null;
    const executionPrice = first.open * (1 + BROKER.slippageBps / 10_000);
    const feeRate = BROKER.feeBps / 10_000;
    const quantity = INITIAL_CAPITAL / (executionPrice * (1 + feeRate));
    const finalEquity = quantity * last.close;
    return {
      totalReturn: finalEquity / INITIAL_CAPITAL - 1,
      pnl: finalEquity - INITIAL_CAPITAL,
    };
  })();

  console.log(
    JSON.stringify(
      {
        protocol: "models/funding-edge-campaign.md §B (v2, DAO #35)",
        verdict,
        A0: {
          satisfait: true,
          joursOos,
          joursRequis: oosMinDays,
          fenetre: { startAt: oosStartAt, endAt: oosEndAt },
        },
        seuilEntree: ENTER_THRESHOLD,
        warmupPrefixJours: prefixCount,
        runs: outcomes,
        benchmarkBuyAndHoldOos: benchmark,
        baselineMax: { id: baselineMaxId, sharpe: baselineMaxSharpe },
        grille,
        note: "Verdict mécanique unique (INV-C7) — aucun recalibrage, aucune réévaluation.",
      },
      null,
      2,
    ),
  );
}
