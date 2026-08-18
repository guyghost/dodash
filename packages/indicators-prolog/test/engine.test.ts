import { describe, expect, it } from "vitest";

import type { Candle } from "@dodash/domain";

import { computeIndicators } from "../src/index.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 10,
  }));

const config = {
  rsiPeriod: 5,
  emaFastPeriod: 3,
  emaSlowPeriod: 5,
  atrPeriod: 3,
} as const;

describe("computeIndicators", () => {
  it("calcule les indicateurs avec Tau-Prolog", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 11, 12, 13, 14, 15, 16, 17]),
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rsi).toBe(100);
    expect(result.value.emaFast).toBeGreaterThan(result.value.emaSlow);
    expect(result.value.macd).toBeCloseTo(
      result.value.emaFast - result.value.emaSlow,
      10,
    );
    expect(result.value.atr).toBeCloseTo(2, 10);
  });

  it("retourne RSI 50 pour un marché plat", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 10, 10, 10, 10, 10]),
      config,
    );
    expect(result.ok && result.value.rsi).toBe(50);
  });

  it("retourne RSI 0 sans aucun gain", async () => {
    const result = await computeIndicators(
      candlesFromCloses([10, 9, 8, 7, 6, 5]),
      config,
    );
    expect(result.ok && result.value.rsi).toBe(0);
  });

  it("refuse un historique trop court", async () => {
    const result = await computeIndicators(candlesFromCloses([10, 11]), config);
    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CANDLES", required: 6, actual: 2 },
    });
  });

  it("produit un identifiant déterministe", async () => {
    const candles = candlesFromCloses([10, 11, 12, 13, 14, 15]);
    const first = await computeIndicators(candles, config);
    const second = await computeIndicators(candles, config);
    expect(first.ok && second.ok && first.value.snapshotId).toBe(
      second.ok ? second.value.snapshotId : "",
    );
  });
});

