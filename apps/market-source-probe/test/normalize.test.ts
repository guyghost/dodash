import { describe, expect, it } from "vitest";
import { compareLatestCloses, normalizeProbePayload } from "../src/normalize.js";
import { CANDLE_LIMIT, DAY, planProbeRequests } from "../src/plan.js";

const closedAt = Date.UTC(2026, 9, 13);
const requests = planProbeRequests(closedAt);
const candles = Array.from({ length: CANDLE_LIMIT }, (_, i) => ({
  start: closedAt - (CANDLE_LIMIT - i) * DAY,
  open: 10, high: 11, low: 9, close: 10, volume: 1,
}));

describe("provider boundary normalization", () => {
  it("normalizes the four provider formats onto the exact same closed grid", () => {
    for (const request of requests.filter((r) => r.product === "BTC-USD" && r.kind === "candles")) {
      const payload = request.provider === "coinbase-exchange"
        ? candles.map((c) => [c.start / 1000, c.low, c.high, c.open, c.close, c.volume])
        : request.provider === "hyperliquid"
          ? candles.map((c) => ({ t: c.start, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, s: "BTC", i: "1d" }))
          : request.provider === "dydx"
            ? { candles: candles.map((c) => ({ ...c, startedAt: new Date(c.start).toISOString(), baseTokenVolume: c.volume, ticker: "BTC-USD", resolution: "1DAY" })) }
            : { candles: candles.map((c) => ({ ...c, start: c.start / 1000 })) };
      expect(normalizeProbePayload(request, payload, closedAt)).toMatchObject({
        ready: true, closedCount: 240, latestStart: closedAt - DAY, latestClose: 10,
      });
    }
  });
  it("excludes the open candle and rejects invalid grid and OHLCV", () => {
    const request = requests[0]!;
    const raw = candles.map((c) => ({ ...c, start: c.start / 1000 }));
    expect(normalizeProbePayload(request, { candles: [...raw, { ...raw[0], start: closedAt / 1000 }] }, closedAt)).toMatchObject({ ready: true, closedCount: 240 });
    expect(() => normalizeProbePayload(request, { candles: [{ ...raw[0], high: 1 }] }, closedAt)).toThrow();
    expect(() => normalizeProbePayload(request, { candles: [{ ...raw[0], start: 0.1 }] }, closedAt)).toThrow();
    expect(() => normalizeProbePayload(request, { candles: [{ ...raw[0], volume: "" }] }, closedAt)).toThrow();
  });
  it("keeps last/mid/book semantics and never substitutes the fetch time", () => {
    const quote = (provider: string) => requests.find((r) => r.kind === "quote" && r.provider === provider)!;
    expect(normalizeProbePayload(quote("coinbase-exchange"), { price: "12", time: "2026-10-13T00:00:00Z" }, closedAt)).toMatchObject({ priceKind: "last", sourceObservedAt: closedAt });
    expect(normalizeProbePayload(quote("hyperliquid"), { BTC: "12", ETH: "13" }, closedAt)).toMatchObject({ priceKind: "mid-or-last", sourceObservedAt: null });
    expect(normalizeProbePayload(quote("dydx"), { bids: [{ price: "11" }, { price: "10" }], asks: [{ price: "15" }, { price: "13" }] }, closedAt)).toMatchObject({ priceKind: "book-mid", prices: { "BTC-USD": 12 }, sourceObservedAt: null });
    expect(() => normalizeProbePayload(quote("dydx"), { bids: [{ price: 15 }], asks: [{ price: 13 }] }, closedAt)).toThrow();
    expect(() => normalizeProbePayload(quote("coinbase-advanced"), { price: "12", product_id: "ETH-USD" }, closedAt)).toThrow();
    expect(compareLatestCloses([]).every((r) => r.referenceStart === null)).toBe(true);
  });
});
