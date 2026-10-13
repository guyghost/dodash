import { describe, expect, it } from "vitest";
import { CANDLE_LIMIT, DAY, planProbeRequests } from "../src/plan.js";

describe("fixed read-only plan", () => {
  it("bounds calls, products, hosts and daily windows", () => {
    const now = Date.UTC(2026, 9, 13, 23, 59);
    const requests = planProbeRequests(now);
    expect(requests).toHaveLength(15);
    expect(requests.filter((r) => r.kind === "candles")).toHaveLength(8);
    expect(new Set(requests.map((r) => new URL(r.url).hostname))).toEqual(new Set([
      "api.coinbase.com", "api.exchange.coinbase.com", "api.hyperliquid.xyz", "indexer.dydx.trade",
    ]));
    const first = new URL(requests[0]!.url);
    const close = Math.floor(now / DAY) * DAY;
    expect(Number(first.searchParams.get("end")) * 1000).toBe(close - DAY);
    expect(Number(first.searchParams.get("start")) * 1000).toBe(close - CANDLE_LIMIT * DAY);
    const dydx = new URL(requests.find((r) => r.provider === "dydx" && r.kind === "candles")!.url);
    expect(Date.parse(dydx.searchParams.get("toISO")!)).toBe(close);
    expect(requests.every((r) => r.body === undefined || new URL(r.url).pathname === "/info")).toBe(true);
  });
});
