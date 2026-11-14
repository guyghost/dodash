import { describe, expect, it } from "vitest";

import { handleWorkerRequest } from "../src/index.js";

const env = {
  COINBASE_API_BASE_URL: "https://api.coinbase.test",
  MARKET_CACHE_TTL_SECONDS: "30",
  INTERNAL_SERVICE_TOKEN: "x".repeat(32),
  MARKET_CACHE: {
    get: async () => null,
    put: async () => undefined,
  },
} as unknown as Env & { INTERNAL_SERVICE_TOKEN: string };

const context = {} as ExecutionContext;

describe("market data worker routing", () => {
  it("exposes a public health response", async () => {
    const response = await handleWorkerRequest(
      new Request("https://market.test/health"),
      env,
      context,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "dodash-mcp-market-data",
    });
  });

  it("fails closed on unauthenticated internal requests", async () => {
    const response = await handleWorkerRequest(
      new Request("https://market.test/internal/ticker", {
        method: "POST",
        body: JSON.stringify({ productId: "BTC-USD" }),
      }),
      env,
      context,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("propagates the upstream Retry-After on internal 429 responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "9" } })) as typeof fetch;
    try {
      const response = await handleWorkerRequest(
        new Request("https://market.test/internal/ticker", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"x".repeat(32)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ productId: "BTC-USD" }),
        }),
        env,
        context,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("9");
      await expect(response.json()).resolves.toEqual({
        error: { code: "RATE_LIMITED", retryAfterSeconds: 9 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const DAY = 86_400_000;
  // limit 2 needs end ≥ 2 days so the Coinbase window start stays ≥ 0.
  // `end` is the newest closed candle start, in seconds.
  const endSeconds = (2 * DAY) / 1000;
  const anchorStart = DAY;
  const newestStart = 2 * DAY;
  const hyperliquidCandles = JSON.stringify([
    { t: anchorStart, o: "100", h: "101", l: "99", c: "100.4", v: "1", s: "BTC" },
    { t: newestStart, o: "100.4", h: "102", l: "100", c: "101", v: "2", s: "BTC" },
  ]);
  const coinbaseCandle = JSON.stringify({
    candles: [
      { start: endSeconds, open: 100, high: 101, low: 99, close: 100.5, volume: 3 },
    ],
  });

  const candleRequest = () =>
    new Request("https://market.test/internal/candles", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"x".repeat(32)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        productId: "BTC-USD",
        timeframe: "ONE_DAY",
        limit: 2,
        end: endSeconds,
      }),
    });

  it("serves the Hyperliquid mark when Coinbase is rate limited and an older close still anchors it", async () => {
    const urls: string[] = [];
    const upstream = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("hyperliquid.xyz")) {
        return new Response(hyperliquidCandles, { status: 200 });
      }
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "9" },
      });
    }) as typeof globalThis.fetch;
    const response = await handleWorkerRequest(
      candleRequest(),
      {
        ...env,
        MARKET_CACHE: {
          get: async (key: string) =>
            key === "basis:ref:BTC-USD:ONE_DAY"
              ? JSON.stringify({
                  close: 100,
                  candleStart: anchorStart,
                  fetchedAt: Date.now() - 24 * 3_600_000,
                })
              : null,
          put: async () => undefined,
        },
      } as unknown as typeof env,
      context,
      { fetch: upstream, sleep: async () => undefined, randomUnit: () => 0.5 },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      source: string;
      candles: { start: number; close: number }[];
      attempts: { source: string; failure: string }[];
    };
    expect(body.source).toBe("hyperliquid");
    expect(body.candles.at(-1)).toMatchObject({ start: newestStart, close: 101 });
    expect(body.attempts).toEqual([
      { source: "COINBASE", failure: "RATE_LIMITED" },
    ]);
    expect(urls.some((url) => url.includes("dydx"))).toBe(false);
    expect(urls.some((url) => url.includes("hyperliquid.xyz"))).toBe(true);
  });

  it("keeps Coinbase when it is healthy and does not call a backup", async () => {
    const urls: string[] = [];
    const upstream = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("hyperliquid.xyz") || url.includes("dydx")) {
        throw new Error("backup fetched while Coinbase was healthy");
      }
      return new Response(coinbaseCandle, { status: 200 });
    }) as typeof globalThis.fetch;
    const response = await handleWorkerRequest(
      candleRequest(),
      env,
      context,
      { fetch: upstream, sleep: async () => undefined, randomUnit: () => 0 },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "coinbase",
      candles: [{ close: 100.5 }],
    });
    expect(urls).toHaveLength(1);
  });

  it("stays closed when Coinbase is rate limited and no anchor exists", async () => {
    const urls: string[] = [];
    const upstream = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("hyperliquid.xyz")) {
        return new Response(hyperliquidCandles, { status: 200 });
      }
      return new Response("no", { status: 429, headers: { "retry-after": "9" } });
    }) as typeof globalThis.fetch;
    const response = await handleWorkerRequest(
      candleRequest(),
      env,
      context,
      { fetch: upstream, sleep: async () => undefined, randomUnit: () => 0.5 },
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(urls.some((url) => url.includes("hyperliquid.xyz"))).toBe(true);
    expect(urls.some((url) => url.includes("dydx"))).toBe(true);
  });
});
