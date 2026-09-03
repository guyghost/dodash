// Diagnostic années faibles — protocole models/weak-year-diagnosis.md §3.
// M1 jours/régime, M2 PnL par régime de clôture, M3 exit vs directionnel,
// M4 stops/takes par régime, M5 solo + ablation par stratégie.
// INV-D1 : Σ PnL (régime × flux) = Σ realizedPnl. INV-D2 : run ensemble
// bit-identique à la ligne IDENTITY de la grille D2-S.

import { createActor } from "xstate";

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { TIMEFRAME_MILLISECONDS, createProductId } from "@dodash/domain";
import { regimeFilterMachine, type RegimeKind } from "@dodash/models";
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

const WEAK_YEARS = [2019, 2021, 2022] as const;
const STRONG_YEARS = [2016, 2020, 2024] as const;

// INV-D2 : lignes IDENTITY publiées dans models/regime-sizing.md §8
// (ret/dd arrondis à 2 décimales en % -> tolérance 0.0001).
const EXPECTED_D2S: Readonly<Record<number, { ret: number; dd: number }>> = {
  2016: { ret: 0.0235, dd: 0.015 },
  2019: { ret: -0.026, dd: 0.0345 },
  2020: { ret: 0.1133, dd: 0.0482 },
  2021: { ret: -0.0581, dd: 0.0621 },
  2022: { ret: -0.0103, dd: 0.0174 },
  2024: { ret: 0.0201, dd: 0.0059 },
};

const REGIME_POLICY = Object.freeze({
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 5,
  confirmationCount: 3,
}) as const;

const DAY = 86_400_000;
const windowBounds = (year: number): { startAt: number; endAt: number } => {
  const startAt = Date.parse(`${year}-08-21T00:00:00Z`);
  const endAt = Date.parse(`${year + 1}-08-21T00:00:00Z`);
  if (Number.isNaN(startAt) || Number.isNaN(endAt) || startAt % DAY !== 0 || endAt % DAY !== 0) {
    throw new Error(`unaligned window ${year}`);
  }
  return { startAt, endAt };
};

const suiteConfig = (year: number): BacktestSuiteConfig =>
  ({
    runId: `weak-year-${year}`,
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
    regimeFilter: REGIME_POLICY,
    regimeConditionalSizing: Object.freeze({
      bullish: "IDENTITY",
      bearish: "IDENTITY",
      range: "IDENTITY",
      warmUp: "IDENTITY",
    }),
  }) as BacktestSuiteConfig;

// Miroir de strategiesById (suite.ts L139-173), calibration IDENTITY.
const strategiesFor = (
  config: BacktestSuiteConfig,
  ids: readonly string[],
): readonly Strategy[] => {
  const size = (strategy: Strategy): Strategy =>
    withTargetSignalNotional(strategy, config.targetSignalNotional);
  const calibrate = (strategy: Strategy): Strategy =>
    withConfidenceCalibration(strategy, "IDENTITY");
  const all: Readonly<Record<string, Strategy>> = {
    "rsi-reversion": size(
      createRsiReversionStrategy({
        oversold: 30,
        overbought: 70,
        baseSize: config.targetSignalNotional,
      }),
    ),
    "ema-cross": size(
      calibrate(createEmaCrossStrategy({ baseSize: config.targetSignalNotional })),
    ),
    breakout: size(
      calibrate(
        createBreakoutStrategy({
          lookback: 20,
          baseSize: config.targetSignalNotional,
        }),
      ),
    ),
  };
  const selected = ids.map((id) => all[id]);
  if (selected.some((strategy) => strategy === undefined)) {
    throw new Error(`unknown strategy ${ids.join("+")}`);
  }
  return selected as readonly Strategy[];
};

// Miroir du mapping suite -> replay (suite.ts L261-291).
const replayConfigFor = (
  config: BacktestSuiteConfig,
  strategies: readonly Strategy[],
  suffix: string,
): BacktestConfig => {
  const registry = createStrategyRegistry(strategies);
  if (!registry.ok) throw new Error(JSON.stringify(registry.error));
  return {
    intervalMs: TIMEFRAME_MILLISECONDS["ONE_DAY"],
    runId: `${config.runId}:${suffix}`,
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
    regimeConditionalSizing: config.regimeConditionalSizing,
  };
};

// M1 — timeline du régime (méthode regime-days.ts : send puis lecture).
interface RegimeDay {
  readonly closedAt: number;
  readonly regime: RegimeKind | null;
}

const regimeTimeline = async (
  candles: readonly { readonly start: number }[],
  config: BacktestSuiteConfig,
): Promise<readonly RegimeDay[]> => {
  const prepared = await prepareBacktestIndicators(candles, config.indicators);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const actor = createActor(regimeFilterMachine, { input: { policy: REGIME_POLICY } });
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
    timeline.push({ closedAt: snapshot.candleClosedAt, regime: actor.getSnapshot().context.regime });
  }
  return timeline;
};

const regimeLabel = (regime: RegimeKind | null): string =>
  regime === null ? "warmUp" : regime;

// M2 — dernier régime connu au timestamp du fill.
const regimeAtFill = (timeline: readonly RegimeDay[], executedAt: number): string => {
  let current = "warmUp";
  for (const day of timeline) {
    if (day.closedAt > executedAt) break;
    current = regimeLabel(day.regime);
  }
  return current;
};

const REGIME_ORDER = ["warmUp", "BULLISH", "BEARISH", "RANGE"] as const;

const regimesOf = (report: WindowReport): readonly string[] => {
  const seen = new Set([...Object.keys(report.daysByRegime)]);
  for (const key of [...Object.keys(report.pnl), ...Object.keys(report.exitCounts)]) {
    seen.add(key.split("|")[0]);
  }
  return REGIME_ORDER.filter((regime) => seen.has(regime));
};

interface WindowReport {
  readonly year: number;
  readonly kind: "FAIBLE" | "FORTE";
  readonly daysByRegime: Readonly<Record<string, number>>;
  readonly pnl: Readonly<Record<string, number>>;
  readonly tradeCounts: Readonly<Record<string, number>>;
  readonly exitCounts: Readonly<Record<string, number>>;
  readonly invD1: { readonly sum: number; readonly total: number; readonly ok: boolean };
  readonly invD2: { readonly ret: number; readonly expected: number; readonly ok: boolean };
  readonly returns: Readonly<Record<string, number>>;
  readonly dominantCell: string | null;
}

const runWindow = async (year: number, kind: "FAIBLE" | "FORTE"): Promise<WindowReport> => {
  const config = suiteConfig(year);
  const { startAt, endAt } = windowBounds(year);
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: "BTC-USD",
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));
  const candles = dataset.value.candles;
  console.log(`${year} (${kind}) : ${candles.length} candles chargées`);

  const timeline = await regimeTimeline(candles, config);
  const daysByRegime: Record<string, number> = {};
  for (const day of timeline) {
    const label = regimeLabel(day.regime);
    daysByRegime[label] = (daysByRegime[label] ?? 0) + 1;
  }

  const variants: readonly (readonly [string, readonly string[]])[] = [
    ["full", ["rsi-reversion", "ema-cross", "breakout"]],
    ["solo:rsi-reversion", ["rsi-reversion"]],
    ["solo:ema-cross", ["ema-cross"]],
    ["solo:breakout", ["breakout"]],
    ["minus:rsi-reversion", ["ema-cross", "breakout"]],
    ["minus:ema-cross", ["rsi-reversion", "breakout"]],
    ["minus:breakout", ["rsi-reversion", "ema-cross"]],
  ];

  const pnl: Record<string, number> = {};
  const tradeCounts: Record<string, number> = {};
  const winCounts: Record<string, number> = {};
  const exitCounts: Record<string, number> = {};
  const returns: Record<string, number> = {};
  let sumPnl = 0;
  let fullRet = 0;

  for (const [suffix, ids] of variants) {
    const replay = await replayBacktest(
      candles,
      replayConfigFor(config, strategiesFor(config, ids), suffix),
    );
    if (!replay.ok) throw new Error(`${year}/${suffix}: ${JSON.stringify(replay.error)}`);
    returns[suffix] = replay.value.metrics.totalReturn;
    if (suffix === "full") {
      fullRet = replay.value.metrics.totalReturn;
      for (const trade of replay.value.trades) {
        const regime = regimeAtFill(timeline, trade.fill.executedAt);
        const flux = trade.fill.clientOrderId.startsWith(`${config.runId}:full:protective:`)
          ? "protective"
          : "directional";
        const key = `${regime}|${flux}`;
        pnl[key] = (pnl[key] ?? 0) + trade.realizedPnl;
        tradeCounts[key] = (tradeCounts[key] ?? 0) + 1;
        if (trade.realizedPnl > 0) winCounts[key] = (winCounts[key] ?? 0) + 1;
        sumPnl += trade.realizedPnl;
      }
      for (const exit of replay.value.protectiveExits) {
        const regime = regimeAtFill(timeline, exit.triggeredAt);
        exitCounts[`${regime}|${exit.kind}`] = (exitCounts[`${regime}|${exit.kind}`] ?? 0) + 1;
      }
    }
  }

  const cellSum = Object.values(pnl).reduce((a, b) => a + b, 0);
  const expected = EXPECTED_D2S[year] ?? (() => { throw new Error(`no baseline ${year}`); })();

  // Dominance §4 : |perte nette cellule| / Σ |pertes nettes| >= 0.6.
  const losses = Object.entries(pnl).filter(([, value]) => value < 0);
  const totalLoss = losses.reduce((a, [, value]) => a + Math.abs(value), 0);
  let dominantCell: string | null = null;
  if (totalLoss > 0) {
    for (const [key, value] of losses) {
      if (Math.abs(value) / totalLoss >= 0.6) {
        dominantCell = key;
        break;
      }
    }
  }

  return {
    year,
    kind,
    daysByRegime,
    pnl,
    tradeCounts,
    winCounts,
    exitCounts,
    invD1: { sum: cellSum, total: sumPnl, ok: Math.abs(cellSum - sumPnl) < 0.01 },
    invD2: {
      ret: fullRet,
      expected: expected.ret,
      ok: Math.abs(fullRet - expected.ret) <= 0.0001,
    },
    returns,
    dominantCell,
  };
};

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const usd = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)}$`;

const reports: WindowReport[] = [];
for (const year of WEAK_YEARS) reports.push(await runWindow(year, "FAIBLE"));
for (const year of STRONG_YEARS) reports.push(await runWindow(year, "FORTE"));

console.log("\n== Diagnostic années faibles (models/weak-year-diagnosis.md §3) ==\n");
for (const report of reports) {
  const days = Object.entries(report.daysByRegime)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`--- ${report.year} (${report.kind}) — jours: ${days}`);
  console.log(
    `    INV-D1 ${report.invD1.ok ? "OK" : "FAIL"} (Σ cellules ${usd(report.invD1.sum)} = Σ trades ${usd(report.invD1.total)}) | INV-D2 ${report.invD2.ok ? "OK" : "FAIL"} (ret ${pct(report.invD2.ret)} vs ${pct(report.invD2.expected)})`,
  );
  for (const regime of regimesOf(report)) {
    const dir = report.pnl[`${regime}|directional`];
    const pro = report.pnl[`${regime}|protective`];
    if (dir === undefined && pro === undefined) continue;
    const dirN = report.tradeCounts[`${regime}|directional`] ?? 0;
    const proN = report.tradeCounts[`${regime}|protective`] ?? 0;
    const winRate = (flux: "directional" | "protective"): string => {
      const n = report.tradeCounts[`${regime}|${flux}`] ?? 0;
      if (n === 0) return "—";
      return `${(((report.winCounts[`${regime}|${flux}`] ?? 0) / n) * 100).toFixed(0)}%`;
    };
    const stops = report.exitCounts[`${regime}|STOP_LOSS`] ?? 0;
    const takes = report.exitCounts[`${regime}|TAKE_PROFIT`] ?? 0;
    console.log(
      `    ${regime.padEnd(7)} directionnel ${usd(dir ?? 0).padStart(9)} (${dirN}t, wr ${winRate("directional")}) | protectif ${usd(pro ?? 0).padStart(9)} (${proN}t, wr ${winRate("protective")}) | stops ${stops} takes ${takes}`,
    );
  }
  const solo = ["solo:rsi-reversion", "solo:ema-cross", "solo:breakout"]
    .map((key) => `${key.slice(5)} ${pct(report.returns[key] ?? 0)}`)
    .join(" | ");
  const minus = ["minus:rsi-reversion", "minus:ema-cross", "minus:breakout"]
    .map((key) => {
      const delta = (report.returns[key] ?? 0) - (report.returns.full ?? 0);
      return `sans ${key.slice(6)}: ${pct(delta)}`;
    })
    .join(" | ");
  console.log(`    ensemble ${pct(report.returns.full ?? 0)} | solo : ${solo}`);
  console.log(`    ablation Δret : ${minus}`);
  console.log(
    `    cellule dominante (>=60% de la perte nette) : ${report.dominantCell ?? "aucune (perte diffuse ou nulle)"}`,
  );
}

const invD1All = reports.every((r) => r.invD1.ok);
const invD2All = reports.every((r) => r.invD2.ok);
console.log(
  `\nINV-D1 global : ${invD1All ? "PASS" : "FAIL"} | INV-D2 global : ${invD2All ? "PASS" : "FAIL"}`,
);

// Dump complet (cellules, effectifs, win rates, exit counts) pour §6.
import { writeFileSync } from "node:fs";
writeFileSync(
  "/tmp/weak-year-attribution.json",
  JSON.stringify(reports, null, 2),
);
console.log("rapport JSON : /tmp/weak-year-attribution.json");
