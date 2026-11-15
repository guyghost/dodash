import { describe, expect, it } from "vitest";
import { consumeP7Depth, planP7Pricing, valueP7Liquidation, consolidateP7Marks } from "./p7-prospective-pricing.js";
const start = Date.UTC(2026, 9, 16);
const scope = { productId: "BTC-USD" as const, sourceProfileId: "fixture", clockVerified: true, campaignStartAt: start,
  campaignEndAt: start + 180 * 86_400_000, candleClosedAt: start, intentPersistedAt: start + 1, previousSequence: null };
const at = start + 1_000;
const book = { productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
  requestedAt: at - 100, receivedAt: at, sourceObservedAt: at - 50,
  bids: [{ price: 99, quantity: 1 }, { price: 98, quantity: 2 }], asks: [{ price: 101, quantity: 1 }, { price: 102, quantity: 2 }] };
describe("P7 synthetic pricing and liquidation", () => {
  it("consumes asks and bids with exact multi-level VWAP", () => {
    expect(consumeP7Depth(book, "BUY", 2)).toMatchObject({ ok: true, vwap: 101.5, notional: 203 });
    expect(consumeP7Depth(book, "SELL", 2)).toMatchObject({ ok: true, vwap: 98.5, notional: 197 });
  });
  it("does not extrapolate, resize or tolerate missing depth", () => {
    expect(consumeP7Depth(book, "BUY", 3).ok).toBe(true);
    expect(consumeP7Depth(book, "BUY", 3 + 1e-12)).toEqual({ ok: false, reason: "INSUFFICIENT_DEPTH" });
    for (const q of [0, -1, NaN, Infinity]) expect(consumeP7Depth(book, "BUY", q).ok).toBe(false);
  });
  it("rejects unsorted, duplicated, crossed and overflowing books", () => {
    for (const asks of [[{ price: 101, quantity: 1 }, { price: 101, quantity: 1 }], [{ price: 100, quantity: 1 }, { price: 99, quantity: 1 }]])
      expect(consumeP7Depth({ ...book, asks }, "BUY", 1).ok).toBe(false);
    expect(consumeP7Depth({ ...book, bids: [{ price: 103, quantity: 1 }] }, "BUY", 1).ok).toBe(false);
    expect(consumeP7Depth({ ...book, asks: [{ price: Number.MAX_VALUE, quantity: 2 }] }, "BUY", 2).ok).toBe(false);
    expect(consumeP7Depth({ ...book, bids: [{ price: Number.MIN_VALUE, quantity: 1 }] }, "SELL", Number.MIN_VALUE).ok).toBe(false);
  });
  it("checks source freshness at use, not just at reception", () => {
    expect(planP7Pricing(scope, book, "BUY", 2, at + 4_950).ok).toBe(true);
    expect(planP7Pricing(scope, book, "BUY", 2, at + 4_951).ok).toBe(false);
    expect(planP7Pricing(scope, book, "BUY", 2, at - 1).ok).toBe(false);
    expect(planP7Pricing({ ...scope, clockVerified: false }, book, "BUY", 2, at).ok).toBe(false);
    expect(planP7Pricing(scope, { ...book, cacheStatus: "UNKNOWN" }, "BUY", 2, at).ok).toBe(false);
  });
  it("keeps execution deadline inclusive and end exclusive", () => {
    const deadline = start + 7_200_000;
    const fresh = { ...book, requestedAt: deadline, receivedAt: deadline, sourceObservedAt: deadline };
    expect(planP7Pricing(scope, fresh, "BUY", 1, deadline).ok).toBe(true);
    expect(planP7Pricing(scope, fresh, "BUY", 1, deadline + 1).ok).toBe(false);
    expect(planP7Pricing(scope, fresh, "BUY", 1, scope.campaignEndAt).ok).toBe(false);
  });
  it("values an afternoon position without the daily execution deadline", () => {
    const afternoon = start + 12 * 3_600_000;
    const fresh = { ...book, requestedAt: afternoon, receivedAt: afternoon, sourceObservedAt: afternoon };
    const portfolio = Object.freeze({ cash: 100, positionQuantity: 2 });
    const result = valueP7Liquidation(scope, fresh, portfolio, afternoon);
    expect(result.available).toBe(true);
    if (result.available) expect(result.equity).toBeCloseTo(100 + 197 * 0.9998 * 0.994, 10);
    expect(portfolio).toEqual({ cash: 100, positionQuantity: 2 });
  });
  it("flat cash needs no fabricated quote but invalid holdings are unavailable", () => {
    expect(valueP7Liquidation(scope, null, { cash: 123, positionQuantity: 0 }, at)).toMatchObject({ available: true, equity: 123, source: "CASH" });
    for (const portfolio of [{ cash: -1, positionQuantity: 0 }, { cash: 1, positionQuantity: NaN }])
      expect(valueP7Liquidation(scope, null, portfolio, at).available).toBe(false);
    expect(valueP7Liquidation(scope, book, { cash: 1, positionQuantity: 4 }, at)).toMatchObject({ available: false, equity: null });
  });
  it("permits a fresh final mark at T1 but no observation received at T1", () => {
    const end = scope.campaignEndAt;
    const final = { ...book, requestedAt: end - 100, receivedAt: end - 50, sourceObservedAt: end - 50 };
    expect(valueP7Liquidation(scope, final, { cash: 0, positionQuantity: 1 }, end).available).toBe(true);
    expect(valueP7Liquidation(scope, { ...final, receivedAt: end }, { cash: 0, positionQuantity: 1 }, end).available).toBe(false);
  });
  it("consolidates only both products at the same observation time", () => {
    const btc = valueP7Liquidation(scope, null, { cash: 10, positionQuantity: 0 }, at);
    const eth = valueP7Liquidation({ ...scope, productId: "ETH-USD" }, null, { cash: 20, positionQuantity: 0 }, at);
    expect(consolidateP7Marks([btc, eth])).toEqual({ available: true, asOf: at, equity: 30 });
    for (const marks of [[btc], [btc, btc], [btc, { ...eth, asOf: at + 1 }]]) expect(consolidateP7Marks(marks).available).toBe(false);
  });
  it.each([
    { productId: "ETH-USD" }, { sourceProfileId: "wrong" }, { sourceObservedAt: null },
    { sourceObservedAt: at + 1 }, { requestedAt: at - 5_001 }, { sequence: "-1" },
  ])("rejects unverifiable mark evidence %j", (override) => {
    expect(valueP7Liquidation(scope, { ...book, ...override }, { cash: 0, positionQuantity: 1 }, at).available).toBe(false);
  });
  it("refuses a regressive sequence and unknown clock for an open position", () => {
    expect(valueP7Liquidation({ ...scope, previousSequence: "2" }, book, { cash: 0, positionQuantity: 1 }, at).available).toBe(false);
    expect(valueP7Liquidation({ ...scope, clockVerified: false }, book, { cash: 0, positionQuantity: 1 }, at).available).toBe(false);
    expect(valueP7Liquidation(scope, book, { cash: 0, positionQuantity: 1 }, at + 4_951).available).toBe(false);
  });
});
