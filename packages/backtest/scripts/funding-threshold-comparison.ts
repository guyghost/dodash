// DAO #38 — rejeu comparatif du seuil d'entrée funding-trend, v1 vs v2,
// sur les fixtures campagne-1 (dao30, fenêtre H12 close) et la
// continuation dao35 (préfixe 90 bougies + fenêtre OOS de 3 jours).
// MODE COMPARAISON DESCRIPTIF (models/funding-rate-strategy.md §5,
// amendement dao #38, INV-F9) :
//   — v1 : enterThreshold 5e-5 explicite (config campagne #30) ;
//   — v2 : défaut produit = FUNDING_TREND_ENTER_THRESHOLD (percentile
//     p75 figé, re-vérifié contre l'annexe #35 — tout écart est fatal).
// C1 : aucun branchement runtime/paper — DEFAULT_REGIME_PERMISSIONS
// inchangé (funding-trend déniée partout) ; ce script ne touche aucune
// permission, aucun code de trading (lecture-seule, miroir campagne).
// C2 : la config de rejeu est celle des campagnes §4, seul le seuil
// diffère entre les deux bras ; le script campagne v1
// (funding-edge-walkforward.ts) reste inchangé et reproductible.
// INV-C7 (#35) : la grille A1–A4 de la campagne n'est PAS évaluée ici —
// comparaison descriptive uniquement.
// Exécution : npx tsx packages/backtest/scripts/funding-threshold-comparison.ts

import { readFile } from "node:fs/promises";

import {
  createProductId,
  TIMEFRAME_MILLISECONDS,
  type Candle,
} from "@dodash/domain";
import {
  computeIndicators,
  DEFAULT_INDICATOR_CONFIG,
  FUNDING_AVG_PERIOD,
  requiredIndicatorCandles,
} from "@dodash/indicators-prolog";
import { FUNDING_TREND_ENTER_THRESHOLD } from "@dodash/models";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createFundingTrendStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  withTargetSignalNotional,
  type Strategy,
} from "@dodash/strategies";

import { replayBacktest, type BacktestConfig } from "../src/replay.js";

// Seuil v1 (config campagne #30, figée) — bras de comparaison.
const V1_ENTER_THRESHOLD = 5e-5;
const DAY = 86_400_000;

// Fenêtre H12 campagne-1 (dao30) et fenêtre OOS collectée (dao35).
const H12_START = Date.parse("2025-09-01T00:00:00Z");
const H12_END = Date.parse("2026-09-01T00:00:00Z");
const OOS_START = Date.parse("2026-09-01T00:00:00Z");
const OOS_END = Date.parse("2026-09-04T00:00:00Z");
const WARMUP_PREFIX_DAYS = 90;

// Config figée (§4 campagne, reprise à l'identique — INV-C5).
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
// une erreur — miroir de la validation de collecte.
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

// Conventions de segment des campagnes : premier rendement incluant la
// jonction, drawdown relatif au pic local, trades par fill.executedAt,
// Sharpe annualisé √252 (écart-type n−1).
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

// Fixtures campagne-1 (dao30) — empreintes vérifiées.
const funding30 = await loadFixture<{
  readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
}>(
  "packages/backtest/fixtures/dao30-funding-btc.json",
  "packages/backtest/fixtures/dao30-funding-btc.provenance.json",
);
const price30 = await loadFixture<{ readonly candles: readonly Candle[] }>(
  "packages/backtest/fixtures/dao30-price-btc-usd.json",
  "packages/backtest/fixtures/dao30-price-btc-usd.provenance.json",
);
// Fixtures continuation (dao35 OOS) — empreintes vérifiées.
const funding35 = await loadFixture<{
  readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
}>(
  "packages/backtest/fixtures/dao35-funding-btc-oos.json",
  "packages/backtest/fixtures/dao35-funding-btc-oos.provenance.json",
);
const price35 = await loadFixture<{ readonly candles: readonly Candle[] }>(
  "packages/backtest/fixtures/dao35-price-btc-usd-oos.json",
  "packages/backtest/fixtures/dao35-price-btc-usd-oos.provenance.json",
);

// C3 : la constante figée du modèle est re-vérifiée contre l'annexe de
// calibration #35 (artefact commité ANTÉRIEUR à cet amendement).
const annex = JSON.parse(
  await readFile(
    "models/funding-edge-campaign-v2.annexe-calibration.json",
    "utf8",
  ),
) as {
  readonly distributionAbsFundingAvg: { readonly p75: number };
};
if (FUNDING_TREND_ENTER_THRESHOLD !== annex.distributionAbsFundingAvg.p75) {
  throw new Error(
    "constante FUNDING_TREND_ENTER_THRESHOLD != annexe p75 (écart fatal, C3)",
  );
}
const annexBytes = await readFile(
  "models/funding-edge-campaign-v2.annexe-calibration.json",
);
const annexSha256 = [
  ...new Uint8Array(await crypto.subtle.digest("SHA-256", annexBytes)),
]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const candlesH12 = price30.candles;
const ratesH12 = dailyRatesForCandles(candlesH12, funding30.samples);

// Continuation : préfixe d'échauffement = 90 dernières bougies campagne-1
// (miroir protocole #35 §4.3), puis fenêtre OOS dao35 — contiguïté exigée.
const prefixCandles = candlesH12.slice(-WARMUP_PREFIX_DAYS);
const oosCandles = price35.candles;
const firstOos = oosCandles[0];
const lastPrefix = prefixCandles.at(-1);
if (
  firstOos === undefined ||
  lastPrefix === undefined ||
  firstOos.start !== lastPrefix.start + DAY
) {
  throw new Error("fenêtre OOS non contiguë au préfixe campagne-1");
}
const continuationCandles = [...prefixCandles, ...oosCandles];
const continuationSamples = [...funding30.samples, ...funding35.samples];
const ratesContinuation = dailyRatesForCandles(
  continuationCandles,
  continuationSamples,
);

// Bras de comparaison : v1 explicite (5e-5), v2 = défaut produit (constante
// p75 figée). Même config par ailleurs (C2).
const arms: readonly {
  readonly id: string;
  readonly enterThreshold: number;
  readonly strategy: Strategy;
}[] = [
  {
    id: "v1-seuil-5e-5",
    enterThreshold: V1_ENTER_THRESHOLD,
    strategy: createFundingTrendStrategy({
      enterThreshold: V1_ENTER_THRESHOLD,
      baseSize: TARGET_SIGNAL_NOTIONAL,
    }),
  },
  {
    id: "v2-percentile-p75",
    enterThreshold: FUNDING_TREND_ENTER_THRESHOLD,
    strategy: createFundingTrendStrategy({
      baseSize: TARGET_SIGNAL_NOTIONAL,
    }),
  },
];

const registryFor = (strategy: Strategy) => {
  const registry = createStrategyRegistry([
    withTargetSignalNotional(strategy, TARGET_SIGNAL_NOTIONAL),
  ]);
  if (!registry.ok) throw new Error("registre invalide");
  return registry.value;
};

const configFor = (
  runId: string,
  strategy: Strategy,
  rates: readonly number[],
): BacktestConfig => ({
  intervalMs: TIMEFRAME_MILLISECONDS.ONE_DAY,
  runId: `dao38:${runId}`,
  agentId: "dodash-backtest",
  productId: product.value,
  initialCapital: INITIAL_CAPITAL,
  maxDecisionNotional: 2_000,
  minNetQuantity: 1e-6,
  indicators: DEFAULT_INDICATOR_CONFIG,
  strategies: registryFor(strategy),
  risk: RISK,
  broker: BROKER,
  fundingRates: rates,
});

interface RunMetrics {
  readonly trades: number;
  readonly pnl: number;
  readonly totalReturn: number;
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly fundingPaid: number;
}

const runMetrics = (run: Awaited<ReturnType<typeof replayBacktest>>): RunMetrics => {
  if (!run.ok) throw new Error(`replay: ${run.error.code}`);
  const { metrics, trades, fundingPaid } = run.value;
  return Object.freeze({
    trades: trades.length,
    pnl: metrics.pnl,
    totalReturn: metrics.totalReturn,
    sharpe: metrics.sharpe,
    maxDrawdown: metrics.maxDrawdown,
    turnover: metrics.turnover,
    fundingPaid,
  });
};

// Distribution des signaux au niveau stratégie (avant allocation), par jour
// de décision, miroir calibration-v2 : computeIndicators par jour, suffixe
// 72 aligné bougies, évaluation du signal au seuil du bras.
interface SignalDistribution {
  readonly enterThreshold: number;
  readonly joursDecision: number;
  readonly joursAutorises: number;
  readonly joursLongCarry: number;
  readonly joursShortCrowding: number;
  readonly sellsAvecEmaBearish: number;
  readonly signaux: Readonly<Record<string, number>>;
}

const signalDistribution = async (
  arm: (typeof arms)[number],
  candles: readonly Candle[],
  rates: readonly number[],
  window: { readonly startAt: number; readonly endAt: number },
): Promise<SignalDistribution> => {
  let joursDecision = 0;
  let joursAutorises = 0;
  let joursLongCarry = 0;
  let joursShortCrowding = 0;
  let sellsAvecEmaBearish = 0;
  const signaux: Record<string, number> = {};
  // Miroir du replay : aucun jour de décision avant le warm-up indicateurs.
  const warmup = requiredIndicatorCandles(DEFAULT_INDICATOR_CONFIG);
  for (let index = warmup - 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle === undefined || candle.start < window.startAt) continue;
    if (candle.start >= window.endAt) break;
    const history = candles.slice(0, index + 1);
    const indicators = await computeIndicators(
      history,
      DEFAULT_INDICATOR_CONFIG,
      undefined,
      {
        rates: rates.slice(
          Math.max(0, history.length - FUNDING_AVG_PERIOD),
          history.length,
        ),
        avgPeriod: FUNDING_AVG_PERIOD,
      },
    );
    if (!indicators.ok) throw new Error(`indicateurs: ${indicators.error.code}`);
    joursDecision += 1;
    const fundingAvg = indicators.value.fundingAvg;
    if (fundingAvg !== undefined) {
      const longCarry = fundingAvg <= -arm.enterThreshold;
      const shortCrowding = fundingAvg >= arm.enterThreshold;
      if (longCarry) joursLongCarry += 1;
      if (shortCrowding) {
        joursShortCrowding += 1;
        if (indicators.value.emaFast < indicators.value.emaSlow) {
          sellsAvecEmaBearish += 1;
        }
      }
      if (longCarry || shortCrowding) joursAutorises += 1;
    }
    const evaluated = arm.strategy.evaluate({
      productId: product.value,
      candles: history,
      indicators: indicators.value,
      previousIndicators: null,
    });
    if (!evaluated.ok) throw new Error(`signal: ${evaluated.error.code}`);
    signaux[evaluated.value.reasonCode] =
      (signaux[evaluated.value.reasonCode] ?? 0) + 1;
  }
  return Object.freeze({
    enterThreshold: arm.enterThreshold,
    joursDecision,
    joursAutorises,
    joursLongCarry,
    joursShortCrowding,
    sellsAvecEmaBearish,
    signaux: Object.freeze(signaux),
  });
};

// H12 — rejeux complets (trades/PnL/Sharpe, mode comparaison).
const h12Runs: Record<string, RunMetrics> = {};
for (const arm of arms) {
  const run = await replayBacktest(
    candlesH12,
    configFor(arm.id, arm.strategy, ratesH12),
  );
  h12Runs[arm.id] = runMetrics(run);
}

// H12 — distributions de signaux (niveau stratégie).
const h12Signals: Record<string, SignalDistribution> = {};
for (const arm of arms) {
  h12Signals[arm.id] = await signalDistribution(arm, candlesH12, ratesH12, {
    startAt: H12_START,
    endAt: H12_END,
  });
}

// Continuation dao35 — rejeux [préfixe ‖ OOS], métriques de segment OOS.
const continuationRuns: Record<
  string,
  RunMetrics & {
    readonly oosSegment: {
      readonly sharpe: number;
      readonly maxDrawdown: number;
      readonly trades: number;
    };
  }
> = {};
for (const arm of arms) {
  const run = await replayBacktest(
    continuationCandles,
    configFor(arm.id, arm.strategy, ratesContinuation),
  );
  if (!run.ok) throw new Error(`replay continuation: ${run.error.code}`);
  const before = run.value.equityCurve.findLast((point) => point.at < OOS_START);
  continuationRuns[arm.id] = Object.freeze({
    ...runMetrics(run),
    oosSegment: segmentMetrics(
      run.value.equityCurve,
      run.value.trades,
      { startAt: OOS_START, endAt: OOS_END },
      before?.equity ?? INITIAL_CAPITAL,
    ),
  });
}

// Baselines de contrôle de fenêtre (miroir campagne v1) : leurs seuils ne
// dépendent pas de l'amendement — tout écart vs campagne signalerait une
// déformation du rejeu comparatif.
const legacyRuns: Record<string, RunMetrics> = {};
const legacyStrategies: readonly { readonly id: string; readonly strategy: Strategy }[] = [
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
for (const legacy of legacyStrategies) {
  const run = await replayBacktest(
    candlesH12,
    configFor(legacy.id, legacy.strategy, ratesH12),
  );
  legacyRuns[legacy.id] = runMetrics(run);
}

// Benchmark buy-and-hold (formule de la suite, packages/backtest/src/suite.ts).
const first = candlesH12[0];
const last = candlesH12.at(-1);
let benchmark: { readonly totalReturn: number } | null = null;
if (first !== undefined && last !== undefined) {
  const executionPrice = first.open * (1 + BROKER.slippageBps / 10_000);
  const feeRate = BROKER.feeBps / 10_000;
  const quantity = INITIAL_CAPITAL / (executionPrice * (1 + feeRate));
  const finalEquity = quantity * last.close;
  benchmark = { totalReturn: finalEquity / INITIAL_CAPITAL - 1 };
}

// Constat de structure de signe (pré-enregistré au modèle §5 avant rejeu) :
// min du fundingAvg signé H12 (SMA-72 causale, jours de décision).
const signedAvgH12: number[] = [];
for (let index = FUNDING_AVG_PERIOD - 1; index < candlesH12.length; index += 1) {
  const slice = ratesH12.slice(index - FUNDING_AVG_PERIOD + 1, index + 1);
  signedAvgH12.push(
    slice.reduce((sum, value) => sum + value, 0) / FUNDING_AVG_PERIOD,
  );
}
const minSignedAvgH12 = Math.min(...signedAvgH12);

const v1Signal = h12Signals["v1-seuil-5e-5"];
const v2Signal = h12Signals["v2-percentile-p75"];

console.log(
  JSON.stringify(
    {
      objet: "dao38 — rejeu comparatif seuil funding-trend v1 vs v2",
      modele: "models/funding-rate-strategy.md §5 (amendement dao #38, INV-F9)",
      statut: "COMPARAISON DESCRIPTIVE — variant non validé OOS (INV-F9)",
      campagne35:
        "grille A1–A4 non évaluée ici (INV-C7) — voir docs/campaigns/funding-edge-campaign-v2-2026-09.md",
      fenetres: {
        h12: { startAt: H12_START, endAt: H12_END, bougies: candlesH12.length },
        continuation: {
          prefixeBougies: prefixCandles.length,
          oos: {
            startAt: OOS_START,
            endAt: OOS_END,
            bougies: oosCandles.length,
          },
        },
      },
      constantes: {
        v1EnterThreshold: V1_ENTER_THRESHOLD,
        v2EnterThreshold: FUNDING_TREND_ENTER_THRESHOLD,
        percentile: 75,
        annexeSha256: annexSha256,
        annexeP75Verifie: true,
      },
      h12: {
        runs: h12Runs,
        signaux: h12Signals,
        baselines: legacyRuns,
        benchmarkBuyAndHold: benchmark,
      },
      continuationDao35: { runs: continuationRuns },
      constatStructureSigne: {
        minFundingAvgSigneH12: minSignedAvgH12,
        joursLongCarryH12: {
          v1: v1Signal?.joursLongCarry ?? null,
          v2: v2Signal?.joursLongCarry ?? null,
        },
        lecture:
          "fundingAvg signé strictement positif sur toute la fenêtre ⇒ longCarry (BUY) jamais autorisable ⇒ 0 remplissage attendu quel que soit le seuil positif (rejeu long-only) — constat pré-enregistré au modèle §5 avant rejeu.",
      },
    },
    null,
    2,
  ),
);
