import { describe, expect, it } from "vitest";

import { projectPaperValuation } from "./paper-valuation.js";

const mark = (
  price: number,
  candleClosedAt = 1_000,
  maxMarketStalenessMs = 100,
) => ({
  price,
  source: "COINBASE_CANDLE_CLOSE" as const,
  timeframe: "ONE_DAY",
  candleClosedAt,
  maxMarketStalenessMs,
});

const project = (
  cash: number,
  positionQuantity: number,
  price: number | null,
  asOf = 1_000,
  maxMarketStalenessMs = 100,
) =>
  projectPaperValuation({
    cash,
    positionQuantity,
    mark: price === null ? null : mark(price, 1_000, maxMarketStalenessMs),
    asOf,
  });

describe("projectPaperValuation", () => {
  it("returns unavailable rather than substituting acquisition cost when no mark exists", () => {
    expect(project(8_000, 2, null)).toEqual({
      ok: true,
      value: {
        asOf: 1_000,
        equity: null,
        exposureNotional: null,
        exposureQuality: "unavailable",
        markPrice: null,
        markSource: null,
        timeframe: null,
        candleClosedAt: null,
        ageMs: null,
        quality: "unavailable",
      },
    });
  });

  it("keeps exact cash equity when no position needs a market mark", () => {
    const result = project(10_000, 0, null);
    expect(result).toMatchObject({
      ok: true,
      value: {
        asOf: 1_000,
        equity: 10_000,
        exposureNotional: 0,
        exposureQuality: "fresh",
        quality: "unavailable",
      },
    });
  });

  it("marks a candle fresh at the configured age boundary and stale after it", () => {
    const fresh = projectPaperValuation({
      cash: 8_000,
      positionQuantity: 2,
      mark: mark(1_100, 900, 100),
      asOf: 1_000,
    });
    const stale = projectPaperValuation({
      cash: 8_000,
      positionQuantity: 2,
      mark: mark(1_100, 899, 100),
      asOf: 1_000,
    });

    expect(fresh).toMatchObject({ ok: true, value: { quality: "fresh", exposureQuality: "fresh", ageMs: 100 } });
    expect(stale).toMatchObject({ ok: true, value: { quality: "stale", exposureQuality: "stale", ageMs: 101 } });
    if (stale.ok) expect(stale.value.equity).toBe(10_200);
  });

  it("changes equity by quantity times the mark-price variation", () => {
    const first = project(8_000, 2, 1_000);
    const second = project(8_000, 2, 1_125);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.equity! - first.value.equity!).toBe(2 * 125);
    }
  });

  it("accounts for a filled buy and its fee exactly once through post-fill cash", () => {
    const before = project(1_000, 0, 100);
    const afterBuy = project(778, 2, 120);

    expect(before.ok && afterBuy.ok).toBe(true);
    if (before.ok && afterBuy.ok) {
      expect(afterBuy.value.equity).toBe(
        before.value.equity! + 2 * (120 - 110) - 2,
      );
    }
  });

  it("accounts for a partial sale and its fee once", () => {
    const beforeSale = project(778, 2, 120);
    const afterSale = project(892, 1, 120);

    expect(beforeSale.ok && afterSale.ok).toBe(true);
    if (beforeSale.ok && afterSale.ok) {
      expect(afterSale.value.equity).toBe(
        beforeSale.value.equity! + (115 - 120) - 1,
      );
    }
  });

  it("keeps equity unchanged when there is no fill", () => {
    const before = project(8_000, 2, 1_100);
    const after = project(8_000, 2, 1_100);
    expect(after).toEqual(before);
  });

  it("rejects future marks and invalid input rather than guessing", () => {
    expect(
      projectPaperValuation({
        cash: 1_000,
        positionQuantity: 1,
        mark: mark(100, 1_001, 100),
        asOf: 1_000,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_MARK" } });
    expect(project(-1, 1, 100)).toEqual({
      ok: false,
      error: { code: "INVALID_PORTFOLIO" },
    });
  });
});
