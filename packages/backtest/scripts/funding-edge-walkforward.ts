// Campagne DAO #30 — rejeu comparatif funding-trend vs baseline prix-seul
// (models/funding-edge-campaign.md §4-§6). Config figée par le protocole
// (INV-C1) ; chemin non préparé : les snapshots préparés sont funding-blind
// (models/funding-rate-strategy.review.md), le replay alimente l'indicateur
// du suffixe 72 et déduit le coût avant le point d'équité — Sharpe net de
// funding par construction. Exécution : npx tsx
// packages/backtest/scripts/funding-edge-walkforward.ts

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

// Fenêtres figées (models/funding-edge-campaign.md §2).
const H12_START = Date.parse("2025-09-01T00:00:00Z");
const H12_END = Date.parse("2026-09-01T00:00:00Z");
const SEGMENTS = [
  { id: "F1", startAt: Date.parse("2025-09-01T00:00:00Z"), endAt: Date.parse("2025-12-01T00:00:00Z") },
  { id: "F2", startAt: Date.parse("2025-12-01T00:00:00Z"), endAt: Date.parse("2026-03-01T00:00:00Z") },
  { id: "F3", startAt: Date.parse("2026-03-01T00:00:00Z"), endAt: Date.parse("2026-06-01T00:00:00Z") },
  { id: "F4", startAt: Date.parse("2026-06-01T00:00:00Z"), endAt: Date.parse("2026-09-01T00:00:00Z") },
  { id: "R30", startAt: Date.parse("2026-08-02T00:00:00Z"), endAt: Date.parse("2026-09-01T00:00:00Z") },
] as const;

// Config figée (§4).
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

const loadFixture = async <T>(dataPath: string, provenancePath: string): Promise<T> => {
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
// une erreur (INV-C3) — miroir de la validation de collecte.
const dailyRatesForCandles = (
  candles: readonly Candle[],
  samples: readonly { readonly time: number; readonly fundingRate: number }[],
): readonly number[] => {
  const DAY = 86_400_000;
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

// Conventions de segment figées (protocole §5) : premier rendement
// incluant la jonction, drawdown relatif au pic local du segment,
// trades par fill.executedAt, Sharpe annualisé √252 (écart-type n−1).
interface SegmentMetrics {
  readonly sharpe: number;
  readonly maxDrawdown: number;
  readonly trades: number;
}

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

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

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
}

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("produit invalide");

const fundingFixture = await loadFixture<{
  readonly coin: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly samples: readonly {
    readonly time: number;
    readonly fundingRate: number;
  }[];
}>("packages/backtest/fixtures/dao30-funding-btc.json", "packages/backtest/fixtures/dao30-funding-btc.provenance.json");
const priceFixture = await loadFixture<{
  readonly candles: readonly Candle[];
}>("packages/backtest/fixtures/dao30-price-btc-usd.json", "packages/backtest/fixtures/dao30-price-btc-usd.provenance.json");

const candles = priceFixture.candles;
const fundingRates = dailyRatesForCandles(candles, fundingFixture.samples);

const RUNS: readonly { readonly id: string; readonly strategy: Strategy }[] = [
  {
    id: "funding-trend",
    strategy: createFundingTrendStrategy({
      enterThreshold: 5e-5,
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

const outcomes: RunOutcome[] = [];
for (const run of RUNS) {
  const registry = createStrategyRegistry([
    withTargetSignalNotional(run.strategy, TARGET_SIGNAL_NOTIONAL),
  ]);
  if (!registry.ok) throw new Error(`registre invalide: ${run.id}`);
  const config: BacktestConfig = {
    intervalMs: TIMEFRAME_MILLISECONDS.ONE_DAY,
    runId: `dao30:${run.id}`,
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
  if (!replay.ok) {
    throw new Error(`replay ${run.id}: ${replay.error.code}`);
  }
  const { metrics, equityCurve, trades } = replay.value;
  const segments: Record<string, SegmentMetrics> = {};
  for (const segment of SEGMENTS) {
    const before = equityCurve.findLast(
      (point) => point.at < segment.startAt,
    );
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
  });
}

// Benchmark buy-and-hold, formule de la suite (packages/backtest/src/suite.ts).
const first = candles[0];
const last = candles.at(-1);
let benchmark: { readonly totalReturn: number; readonly pnl: number } | null = null;
if (first !== undefined && last !== undefined) {
  const executionPrice = first.open * (1 + BROKER.slippageBps / 10_000);
  const feeRate = BROKER.feeBps / 10_000;
  const quantity = INITIAL_CAPITAL / (executionPrice * (1 + feeRate));
  const finalEquity = INITIAL_CAPITAL - INITIAL_CAPITAL + quantity * last.close;
  benchmark = {
    totalReturn: finalEquity / INITIAL_CAPITAL - 1,
    pnl: quantity * last.close - INITIAL_CAPITAL,
  };
}

// Seuils recommandés du protocole (§6) — entrées, pas activations (INV-C6).
const fundingRun = outcomes.find((outcome) => outcome.id === "funding-trend");
const legacy = outcomes.filter((outcome) => outcome.id !== "funding-trend");
if (fundingRun === undefined || legacy.length !== 3) {
  throw new Error("runs attendus absents");
}
const baselineMaxSharpe = Math.max(...legacy.map((outcome) => outcome.h12.sharpe));
const baselineMaxDrawdown = Math.max(
  ...legacy.map((outcome) => outcome.h12.maxDrawdown),
);
const baselineMaxId = legacy.find(
  (outcome) => outcome.h12.sharpe === baselineMaxSharpe,
)?.id;
const positiveFoldDifferentials = SEGMENTS.filter((segment) => {
  const differential =
    fundingRun.segments[segment.id] !== undefined
      ? fundingRun.segments[segment.id].sharpe -
        median(legacy.map((outcome) => outcome.segments[segment.id]?.sharpe ?? 0))
      : Number.NaN;
  return differential >= 0;
}).map((segment) => segment.id);
const r30Differential =
  (fundingRun.segments.R30?.sharpe ?? Number.NaN) -
  median(legacy.map((outcome) => outcome.segments.R30?.sharpe ?? 0));

const thresholds = {
  S1_edgeNet: {
    seuil: "sharpeH12(funding-trend) >= sharpeH12(baselineMax) + 0.25",
    valeur: fundingRun.h12.sharpe - baselineMaxSharpe,
    satisfait: fundingRun.h12.sharpe >= baselineMaxSharpe + 0.25,
  },
  S2_activite: {
    seuil: "tradesH12(funding-trend) >= 30",
    valeur: fundingRun.h12.trades,
    satisfait: fundingRun.h12.trades >= 30,
  },
  S3_risque: {
    seuil: "drawdownH12(funding-trend) <= drawdownH12(baselineMax) + 0.05",
    valeur: fundingRun.h12.maxDrawdown - baselineMaxDrawdown,
    satisfait: fundingRun.h12.maxDrawdown <= baselineMaxDrawdown + 0.05,
  },
  S4_stabilite: {
    seuil:
      "differential sharpe vs mediane legacy >= 0 sur >= 3 des 4 trimestres ET >= 0 sur R30",
    valeur: { foldsPositifs: positiveFoldDifferentials, r30Differential },
    satisfait: positiveFoldDifferentials.length >= 3 && r30Differential >= 0,
  },
  S5_nonDestructif: {
    seuil: "sharpeH12(funding-trend) >= 0",
    valeur: fundingRun.h12.sharpe,
    satisfait: fundingRun.h12.sharpe >= 0,
  },
};

console.log(
  JSON.stringify(
    {
      protocol: "models/funding-edge-campaign.md",
      windows: { h12: { startAt: H12_START, endAt: H12_END }, segments: SEGMENTS },
      provenance: {
        fundingSha256: fundingFixture.samples.length > 0 ? "voir fixtures/dao30-funding-btc.provenance.json" : null,
        candles: candles.length,
        dailyRates: fundingRates.length,
      },
      runs: outcomes,
      benchmarkBuyAndHold: benchmark,
      baselineMax: { id: baselineMaxId, sharpe: baselineMaxSharpe },
      thresholds,
    },
    null,
    2,
  ),
);
