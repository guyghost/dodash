import { describe, expect, it } from "vitest";

import {
  createExecutionSchedule,
  resolveRiskEvaluationTimestamp,
} from "./execution-resolution.js";
import type { ExecutionCandle } from "./execution-resolution.types.js";

const executionCandles: readonly ExecutionCandle[] = Object.freeze([
  { start: 0, open: 100, high: 102, low: 99, close: 101, volume: 10 },
  { start: 100, open: 101, high: 103, low: 100, close: 102, volume: 20 },
  { start: 200, open: 102, high: 104, low: 101, close: 103, volume: 30 },
  { start: 300, open: 103, high: 105, low: 102, close: 104, volume: 40 },
  { start: 400, open: 104, high: 106, low: 103, close: 105, volume: 10 },
  { start: 500, open: 105, high: 107, low: 104, close: 106, volume: 20 },
  { start: 600, open: 106, high: 108, low: 105, close: 107, volume: 30 },
  { start: 700, open: 107, high: 109, low: 106, close: 108, volume: 40 },
]);

const primaryCandles: readonly ExecutionCandle[] = Object.freeze([
  { start: 0, open: 100, high: 105, low: 99, close: 104, volume: 100 },
  { start: 400, open: 104, high: 109, low: 103, close: 108, volume: 100 },
]);

describe("createExecutionSchedule", () => {
  it("conserve une résolution 1:1 lorsqu’aucune série fine n’est fournie", () => {
    const result = createExecutionSchedule(primaryCandles.slice(0, 1));

    expect(result).toEqual({
      ok: true,
      value: {
        resolutionRatio: 1,
        buckets: [
          {
            primaryCandle: primaryCandles[0],
            executionCandles: [primaryCandles[0]],
          },
        ],
      },
    });
  });

  it("construit quatre sous-bougies par bougie primaire", () => {
    const result = createExecutionSchedule(primaryCandles, executionCandles);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resolutionRatio).toBe(4);
    expect(result.value.buckets).toHaveLength(2);
    expect(result.value.buckets[0]?.executionCandles.map((item) => item.start)).toEqual([
      0, 100, 200, 300,
    ]);
    expect(result.value.buckets[1]?.executionCandles.map((item) => item.start)).toEqual([
      400, 500, 600, 700,
    ]);
  });

  it("refuse une sous-bougie manquante", () => {
    const result = createExecutionSchedule(
      primaryCandles,
      executionCandles.filter((item) => item.start !== 500),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "MISALIGNED_EXECUTION_RANGE" },
    });
  });

  it("refuse une agrégation de prix incohérente", () => {
    const mismatched = primaryCandles.map((item, index) =>
      index === 0 ? { ...item, high: 106 } : item,
    );

    const result = createExecutionSchedule(mismatched, executionCandles);

    expect(result).toEqual({
      ok: false,
      error: { code: "EXECUTION_AGGREGATION_MISMATCH" },
    });
  });

  it("ignore les écarts de volume entre granularités", () => {
    const materialVolume = primaryCandles.map((item, index) =>
      index === 0 ? { ...item, volume: item.volume + 0.01 } : item,
    );

    expect(createExecutionSchedule(materialVolume, executionCandles).ok).toBe(true);
  });

  it("refuse des intervalles primaires irréguliers", () => {
    const irregularPrimary = [
      ...primaryCandles,
      { start: 900, open: 108, high: 110, low: 107, close: 109, volume: 100 },
    ];

    const result = createExecutionSchedule(irregularPrimary, executionCandles);

    expect(result).toEqual({
      ok: false,
      error: { code: "NON_UNIFORM_PRIMARY_INTERVAL" },
    });
  });
});

describe("resolveRiskEvaluationTimestamp", () => {
  it("conserve l’horloge primaire ou la relève au dernier fill consommé", () => {
    expect(resolveRiskEvaluationTimestamp(1_000, null)).toBe(1_000);
    expect(resolveRiskEvaluationTimestamp(1_000, 900)).toBe(1_000);
    expect(resolveRiskEvaluationTimestamp(1_000, 1_500)).toBe(1_500);
  });
});
