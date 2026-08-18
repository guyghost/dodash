import { describe, expect, it, vi } from "vitest";

import {
  CoinbaseMarketData,
  type MarketCache,
} from "../src/coinbase.js";

class MemoryCache implements MarketCache {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const candleResponse = {
  candles: [
    {
      start: "120",
      low: "11",
      high: "14",
      open: "12",
      close: "13",
      volume: "5",
    },
    {
      start: "60",
      low: "9",
      high: "12",
      open: "10",
      close: "11",
      volume: "4",
    },
  ],
};

const createClient = (
  response: Response,
  cache = new MemoryCache(),
) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  const client = new CoinbaseMarketData({
    baseUrl: "https://api.coinbase.test/",
    cache,
    cacheTtlSeconds: 30,
    fetch: fetchMock,
    now: () => 180_000,
  });
  return { cache, client, fetchMock };
};

describe("CoinbaseMarketData", () => {
  it("validates and sorts candles before returning them", async () => {
    const { client, fetchMock } = createClient(
      Response.json(candleResponse),
    );

    const result = await client.getCandles({
      productId: "btc-usd",
      timeframe: "ONE_MINUTE",
      limit: 2,
      end: 180,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productId).toBe("BTC-USD");
    expect(result.value.candles.map((candle) => candle.start)).toEqual([60, 120]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("granularity=ONE_MINUTE");
  });

  it("serves a validated candle snapshot from cache", async () => {
    const cache = new MemoryCache();
    const first = createClient(Response.json(candleResponse), cache);
    const request = {
      productId: "BTC-USD",
      timeframe: "ONE_MINUTE" as const,
      limit: 2,
      end: 180,
    };
    await first.client.getCandles(request);

    const second = createClient(new Response(null, { status: 500 }), cache);
    const result = await second.client.getCandles(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cached).toBe(true);
    expect(second.fetchMock).not.toHaveBeenCalled();
  });

  it("maps Coinbase rate limits to a closed error", async () => {
    const { client } = createClient(
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    const result = await client.getTicker({ productId: "BTC-USD" });
    expect(result).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", retryAfterSeconds: 7 },
    });
  });

  it("rejects malformed upstream candles", async () => {
    const { client } = createClient(
      Response.json({
        candles: [
          {
            start: "60",
            low: "12",
            high: "10",
            open: "11",
            close: "11",
            volume: "4",
          },
        ],
      }),
    );
    const result = await client.getCandles({
      productId: "BTC-USD",
      timeframe: "ONE_MINUTE",
      limit: 1,
      end: 120,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it("validates ticker prices", async () => {
    const { client } = createClient(Response.json({ price: "102.75" }));
    const result = await client.getTicker({ productId: "ETH-USD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      productId: "ETH-USD",
      price: 102.75,
      observedAt: 180,
      cached: false,
    });
  });
});
