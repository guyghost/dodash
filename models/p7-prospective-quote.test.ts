import { describe, expect, it } from "vitest";
import { evaluateP7ExecutionBook } from "./p7-prospective-quote.js";

const close = Date.UTC(2026, 9, 15);
const scope = {
  productId: "BTC-USD" as const, sourceProfileId: "verified-spot-profile", clockVerified: true,
  campaignStartAt: close, campaignEndAt: close + 180 * 86_400_000,
  candleClosedAt: close, intentPersistedAt: close + 60_000, previousSequence: "99",
};
const quote = () => ({
  productId: "BTC-USD", sourceProfileId: "verified-spot-profile", cacheStatus: "UNCACHED",
  requestedAt: close + 60_001, receivedAt: close + 60_100, sourceObservedAt: close + 60_050,
  sequence: "100", bids: [{ price: 99, quantity: 1 }], asks: [{ price: 101, quantity: 1 }],
});

describe("prospective execution-book evidence", () => {
  it("accepts a verified post-intent fresh book without producing a fill", () => {
    expect(evaluateP7ExecutionBook(scope, quote())).toEqual({ eligible: true, reason: "ELIGIBLE_BOOK" });
  });
  it("does not infer source clock, identity or cache eligibility", () => {
    expect(evaluateP7ExecutionBook({ ...scope, clockVerified: false }, quote()).eligible).toBe(false);
    for (const overrides of [{ productId: "ETH-USD" }, { sourceProfileId: "other" }, { cacheStatus: "UNKNOWN" }, { cacheStatus: "CACHED" }, { sourceObservedAt: null }]) {
      expect(evaluateP7ExecutionBook(scope, { ...quote(), ...overrides }).eligible).toBe(false);
    }
  });
  it("accepts exactly 5s of source age but rejects an older or future quote", () => {
    const book = quote();
    expect(evaluateP7ExecutionBook(scope, { ...book, sourceObservedAt: book.receivedAt - 5_000 }).eligible).toBe(true);
    expect(evaluateP7ExecutionBook(scope, { ...book, sourceObservedAt: book.receivedAt - 5_001 }).eligible).toBe(false);
    expect(evaluateP7ExecutionBook(scope, { ...book, sourceObservedAt: book.receivedAt + 1 }).eligible).toBe(false);
  });
  it("requires a new fetch after the persisted intention and bounds fetch duration", () => {
    const book = quote();
    expect(evaluateP7ExecutionBook(scope, { ...book, requestedAt: scope.intentPersistedAt - 1 }).eligible).toBe(false);
    expect(evaluateP7ExecutionBook(scope, { ...book, receivedAt: book.requestedAt + 5_000, sourceObservedAt: book.requestedAt + 5_000 }).eligible).toBe(true);
    expect(evaluateP7ExecutionBook(scope, { ...book, receivedAt: book.requestedAt + 5_001, sourceObservedAt: book.requestedAt + 5_001 }).eligible).toBe(false);
  });
  it("keeps the 2h decision deadline inclusive and campaign end exclusive", () => {
    const deadline = close + 7_200_000;
    const book = { ...quote(), requestedAt: deadline - 1, receivedAt: deadline, sourceObservedAt: deadline };
    expect(evaluateP7ExecutionBook(scope, book).eligible).toBe(true);
    expect(evaluateP7ExecutionBook(scope, { ...book, receivedAt: deadline + 1, sourceObservedAt: deadline + 1 }).eligible).toBe(false);
    expect(evaluateP7ExecutionBook({ ...scope, campaignEndAt: quote().receivedAt }, quote()).eligible).toBe(false);
    expect(evaluateP7ExecutionBook({ ...scope, campaignStartAt: close + 1 }, quote()).eligible).toBe(false);
  });
  it("rejects malformed, empty, crossed, unordered or invalid-size levels", () => {
    for (const invalid of [null, {}, { ...quote(), bids: [] }, { ...quote(), bids: [{ price: 102, quantity: 1 }] },
      { ...quote(), asks: [{ price: 101, quantity: 0 }] }, { ...quote(), bids: [{ price: 98, quantity: 1 }, { price: 99, quantity: 1 }] },
      { ...quote(), asks: Array.from({ length: 5_001 }, () => ({ price: 101, quantity: 1 })) }]) {
      expect(evaluateP7ExecutionBook(scope, invalid).eligible).toBe(false);
    }
  });
  it("compares bounded decimal sequences without unsafe number conversion", () => {
    expect(evaluateP7ExecutionBook(scope, { ...quote(), sequence: "98" }).eligible).toBe(false);
    expect(evaluateP7ExecutionBook(scope, { ...quote(), sequence: "99" }).eligible).toBe(true);
    expect(evaluateP7ExecutionBook({ ...scope, previousSequence: "9007199254740993" }, { ...quote(), sequence: "9007199254740992" }).eligible).toBe(false);
    expect(evaluateP7ExecutionBook(scope, { ...quote(), sequence: "9".repeat(65) }).eligible).toBe(false);
  });
  it("requires the frozen 180-day UTC campaign and a daily close", () => {
    expect(evaluateP7ExecutionBook({ ...scope, campaignEndAt: scope.campaignEndAt - 86_400_000 }, quote()).eligible).toBe(false);
    expect(evaluateP7ExecutionBook({ ...scope, campaignStartAt: close - 1, campaignEndAt: scope.campaignEndAt - 1 }, quote()).eligible).toBe(false);
    expect(evaluateP7ExecutionBook({ ...scope, candleClosedAt: close + 1 }, quote()).eligible).toBe(false);
  });
});
