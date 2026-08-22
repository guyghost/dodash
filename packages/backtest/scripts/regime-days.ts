import { createActor } from "xstate";

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import { regimeFilterMachine } from "@dodash/models";
import type { RegimeFilterPolicy, RegimeObservation } from "@dodash/models";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import { prepareBacktestIndicators } from "../src/prepared-indicators.js";

// Outil de vérification : compte les jours passés dans chaque régime pour une
// politique donnée (la timeline n'est pas dans les artefacts de backtest).

const run = async (
  label: string,
  startAt: number,
  endAt: number,
  policy: RegimeFilterPolicy,
): Promise<void> => {
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: "BTC-USD",
    timeframe: "ONE_DAY",
    startAt,
    endAt,
  });
  if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));
  const prepared = await prepareBacktestIndicators(
    dataset.value.candles,
    DEFAULT_CONFIG,
  );
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const actor = createActor(regimeFilterMachine, { input: { policy } });
  actor.start();
  const counts: Record<string, number> = { pending: 0 };
  for (const snapshot of prepared.value.snapshots) {
    if (snapshot === null) continue;
    const observation: RegimeObservation = {
      start: snapshot.candleClosedAt,
      emaFast: snapshot.emaFast,
      emaSlow: snapshot.emaSlow,
    };
    const before = actor.getSnapshot().context.regime;
    actor.send({ type: "CANDLE_CLOSED", observation });
    const after = actor.getSnapshot().context.regime;
    const key = after ?? (before === null ? "pending" : before);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const view = Object.entries(counts)
    .map(([k, v]) => `${k}=${v} (${((v / total) * 100).toFixed(0)}%)`)
    .join(" ");
  console.log(`${label}: ${view} [total=${total}]`);
};

const DEFAULT_CONFIG: Parameters<typeof prepareBacktestIndicators>[1] =
  DEFAULT_INDICATOR_CONFIG;

const day = (iso: string): number => Date.parse(iso);

await run(
  "bull threshold100",
  day("2023-08-21"),
  day("2024-08-21"),
  Object.freeze({
    mode: "EMA_THRESHOLD",
    thresholdBps: 100,
    minObservations: 5,
    confirmationCount: 3,
  }),
);
await run(
  "bull slope200/10",
  day("2023-08-21"),
  day("2024-08-21"),
  Object.freeze({
    mode: "EMA_SLOPE",
    slopeThresholdBps: 200,
    slopePeriods: 10,
    minObservations: 5,
    confirmationCount: 3,
  }),
);
await run(
  "bear slope200/10",
  day("2025-08-21"),
  day("2026-08-21"),
  Object.freeze({
    mode: "EMA_SLOPE",
    slopeThresholdBps: 200,
    slopePeriods: 10,
    minObservations: 5,
    confirmationCount: 3,
  }),
);
