import { describe, expect, it, vi } from "vitest";

import {
  CLOSED_WINDOW_CACHE_TTL_SECONDS,
  CoinbaseMarketData,
  type MarketCache,
} from "../src/coinbase.js";

class MemoryCache implements MarketCache {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { readonly expirationTtl: number },
  ): Promise<void> {
    this.values.set(key, value);
    if (options !== undefined) this.ttls.set(key, options.expirationTtl);
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
  it("invokes the platform fetch with its required global receiver", async () => {
    const platformFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json(candleResponse));
    });
    vi.stubGlobal("fetch", platformFetch);
    try {
      const client = new CoinbaseMarketData({
        baseUrl: "https://api.coinbase.test/",
        cache: new MemoryCache(),
        cacheTtlSeconds: 30,
        now: () => 180_000,
      });
      const result = await client.getCandles({
        productId: "BTC-USD",
        timeframe: "ONE_MINUTE",
        limit: 2,
        end: 180,
      });
      expect(result.ok).toBe(true);
      expect(platformFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
    expect(result.value.candles.map((candle) => candle.start)).toEqual([
      60_000,
      120_000,
    ]);
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

describe("CoinbaseMarketData cache policy (effects.md, amendement 2026-09-28)", () => {
  it("caches a fully closed candle window for the immutable TTL", async () => {
    const cache = new MemoryCache();
    const { client } = createClient(Response.json(candleResponse), cache);
    // now = 180 s ; end = 60 s ; ONE_MINUTE ⇒ la dernière chandelle clôt à 120 s ≤ now.
    const result = await client.getCandles({
      productId: "BTC-USD",
      timeframe: "ONE_MINUTE",
      limit: 1,
      end: 60,
    });
    expect(result.ok).toBe(true);
    expect([...cache.ttls.values()]).toEqual([CLOSED_WINDOW_CACHE_TTL_SECONDS]);
    expect(CLOSED_WINDOW_CACHE_TTL_SECONDS).toBe(21_600);
  });

  it("keeps the short TTL when the window contains the open candle", async () => {
    const cache = new MemoryCache();
    const { client } = createClient(Response.json(candleResponse), cache);
    // end = 180 s = now ⇒ la chandelle demandée n'est pas close.
    await client.getCandles({
      productId: "BTC-USD",
      timeframe: "ONE_MINUTE",
      limit: 2,
      end: 180,
    });
    expect([...cache.ttls.values()]).toEqual([30]);
  });

  it("logs upstream rate limiting with its Retry-After (no secret, no body)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client } = createClient(
        new Response("rate limited", { status: 429, headers: { "retry-after": "12" } }),
      );
      await client.getTicker({ productId: "ETH-USD" });
      const logged = warn.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .find((entry) => entry.event === "coinbase_rate_limited");
      expect(logged).toEqual({
        event: "coinbase_rate_limited",
        kind: "ticker",
        productId: "ETH-USD",
        retryAfterSeconds: 12,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("journalise chaque requête marché : statut amont, Retry-After brut et cache (effects.md, 2026-10-07)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests = () =>
      log.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .filter((entry) => entry.event === "coinbase_market_request");
    try {
      const limited = createClient(
        new Response("rate limited", { status: 429, headers: { "retry-after": "12" } }),
      );
      await limited.client.getTicker({ productId: "ETH-USD" });
      expect(requests()).toEqual([
        {
          event: "coinbase_market_request",
          kind: "ticker",
          productId: "ETH-USD",
          cached: false,
          status: 429,
          outcome: "RATE_LIMITED",
          retryAfterRaw: "12",
          latencyMs: 0,
        },
      ]);

      log.mockClear();
      const cache = new MemoryCache();
      const fresh = createClient(Response.json(candleResponse), cache);
      const request = { productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, end: 180 } as const;
      await fresh.client.getCandles(request);
      await fresh.client.getCandles(request);
      expect(requests()).toEqual([
        expect.objectContaining({ kind: "candles", cached: false, status: 200, outcome: "OK", retryAfterRaw: null }),
        expect.objectContaining({ kind: "candles", cached: true, status: null, outcome: "OK", retryAfterRaw: null }),
      ]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
