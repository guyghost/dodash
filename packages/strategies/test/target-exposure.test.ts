import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";

import { createTargetExposureStrategy } from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid fixture product");
const DAY = 86_400_000;
const MONDAY = Date.UTC(2025, 0, 6);

const daily = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: MONDAY - (closes.length - 1 - index) * DAY,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));

const evaluate = (closes: readonly number[]) =>
  createTargetExposureStrategy().evaluate({
    productId: product.value,
    candles: daily(closes),
    indicators: {} as IndicatorSnapshot,
    previousIndicators: null,
  });

const rising = (count: number) =>
  Array.from({ length: count }, (_, index) => 100 * 1.002 ** index * (index % 2 === 0 ? 1.001 : 0.999));

describe("target-exposure (signal informatif, models/target-exposure.md §4)", () => {
  it("reste en HOLD pendant l'échauffement", () => {
    const result = evaluate(rising(100));
    expect(result.ok && result.value).toMatchObject({ side: "HOLD", suggestedSize: 0, reasonCode: "TARGET_EXPOSURE_WARMUP" });
  });

  it("signale la tendance haussière avec la cible pour confiance et une taille nulle", () => {
    const result = evaluate(rising(240));
    expect(result.ok && result.value).toMatchObject({ side: "BUY", confidence: 1, suggestedSize: 0, reasonCode: "TARGET_EXPOSURE_TREND_UP" });
  });

  it("signale la tendance baissière", () => {
    const closes = rising(239);
    closes.push(50);
    const result = evaluate(closes);
    expect(result.ok && result.value).toMatchObject({ side: "SELL", confidence: 0, reasonCode: "TARGET_EXPOSURE_TREND_DOWN" });
  });
});
