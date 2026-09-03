import { describe, expect, it } from "vitest";

import type { Candle } from "@dodash/domain";

import { computeIndicators, type IndicatorConfig } from "../src/index.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 10,
  }));

const config: IndicatorConfig = {
  rsiPeriod: 2,
  emaFastPeriod: 1,
  emaSlowPeriod: 2,
  atrPeriod: 2,
  historicalVolatilityPeriod: 2,
  momentumPeriod: 1,
  returnPeriods: [1],
  vwapPeriod: 2,
  relativeVolumePeriod: 1,
  volumeSpikeThreshold: 2,
  volumeTrendPeriod: 2,
  trendStrengthPeriod: 2,
};

// requiredIndicatorCandles(config) = 4 bougies minimum.
const candles = candlesFromCloses([10, 11, 12, 13, 14, 15]);

describe("computeIndicators — entrée funding (models/funding-rate-strategy.md)", () => {
  it("expose fundingAvg = moyenne des avgPeriod derniers taux (INV-F4)", async () => {
    const result = await computeIndicators(candles, config, undefined, {
      rates: [0.0001, -0.0003, 0.0002, 0.0004, -0.0001, 0.0003],
      avgPeriod: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // moyenne des 3 derniers : (0.0004 - 0.0001 + 0.0003) / 3
    expect(result.value.fundingAvg).toBeCloseTo(0.0002, 12);
  });

  it("gère les taux négatifs (carry favorable aux longs)", async () => {
    const result = await computeIndicators(candles, config, undefined, {
      rates: [-0.0001, -0.0001, -0.0002, -0.0002, -0.0001, -0.0003],
      avgPeriod: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // moyenne des 4 derniers : (−0.0002 − 0.0002 − 0.0001 − 0.0003) / 4
    expect(result.value.fundingAvg).toBeCloseTo(-0.0002, 12);
  });

  it("échauffement : historique plus court que la période ⇒ champ absent (INV-F3)", async () => {
    const short = candlesFromCloses([10, 11, 12, 13, 14]);
    const result = await computeIndicators(short, config, undefined, {
      rates: [0.0001, 0.0002, 0.0001, 0, 0],
      avgPeriod: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fundingAvg).toBeUndefined();
  });

  it("sans entrée funding : snapshot bit-identique, champ absent (INV-F1)", async () => {
    const baseline = await computeIndicators(candles, config);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect("fundingAvg" in baseline.value).toBe(false);
    const withFunding = await computeIndicators(candles, config, undefined, {
      rates: [0, 0, 0, 0, 0, 0],
      avgPeriod: 2,
    });
    expect(withFunding.ok).toBe(true);
    if (!withFunding.ok) return;
    const { fundingAvg: _fundingAvg, ...rest } = withFunding.value;
    expect(rest).toEqual(baseline.value);
  });

  it("rejette une série de longueur ≠ bougies (INV-F2)", async () => {
    const result = await computeIndicators(candles, config, undefined, {
      rates: [0.0001, 0.0002],
      avgPeriod: 2,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_FUNDING_DATA" },
    });
  });

  it("rejette un taux non fini (INV-F2)", async () => {
    const result = await computeIndicators(candles, config, undefined, {
      rates: [0.0001, 0.0002, 0.0001, Number.NaN, 0, 0],
      avgPeriod: 2,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_FUNDING_DATA" },
    });
  });

  it("rejette une période < 2 (INV-F2)", async () => {
    const result = await computeIndicators(candles, config, undefined, {
      rates: [0.0001, 0.0002, 0.0001, 0, 0, 0],
      avgPeriod: 1,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_FUNDING_DATA" },
    });
  });
});
