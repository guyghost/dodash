import { describe, expect, it, vi } from "vitest";

import { parseAgentConfiguration } from "../src/configuration.js";
import { fetchMarketSnapshot } from "../src/market-service.js";

const configuration = () => {
  const result = parseAgentConfiguration({
    productId: "BTC-USD",
    strategyIds: ["rsi-reversion"],
  });
  if (!result.ok) throw new Error("invalid configuration fixture");
  return result.value;
};

const candle = (start: number, close = 10) => ({
  start,
  open: 10,
  high: 11,
  low: 9,
  close,
  volume: 1,
});

const candlesResponse = (candles: readonly unknown[]) =>
  Response.json({
    productId: "BTC-USD",
    timeframe: "ONE_MINUTE",
    candles,
    source: "hyperliquid",
    cached: false,
  });

const tickerResponse = (price: number) =>
  Response.json({
    productId: "BTC-USD",
    price,
    observedAt: 120_000,
    source: "hyperliquid",
    cached: false,
  });

const marketFetch = (candles: Response, ticker: Response) =>
  vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      String(_input).endsWith("/internal/ticker") ? ticker : candles,
  );

describe("fetchMarketSnapshot", () => {
  it("authenticates the service binding and revalidates the response", async () => {
    const fetch = marketFetch(candlesResponse([candle(0)]), tickerResponse(10));
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
    );

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${"x".repeat(32)}`,
    );
    const tickerInit = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(tickerInit.headers).get("authorization")).toBe(
      `Bearer ${"x".repeat(32)}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      productId: "BTC-USD",
      timeframe: "ONE_MINUTE",
      limit: configuration().candleLimit,
      end: 60,
      sources: ["HYPERLIQUID"],
    });
    expect(JSON.parse(String(tickerInit.body))).toEqual({
      productId: "BTC-USD",
      sources: ["HYPERLIQUID"],
    });
  });

  it("excludes the candle that opens at the current bucket boundary", async () => {
    const fetch = marketFetch(
      candlesResponse([candle(60_000)]),
      tickerResponse(10),
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candles.at(-1)?.start).toBe(60_000);
    expect(result.value.valuationMark).toEqual({
      price: 10,
      source: "HYPERLIQUID_CANDLE_CLOSE",
      timeframe: "ONE_MINUTE",
      candleClosedAt: 120_000,
      maxMarketStalenessMs: configuration().maxMarketStalenessMs,
    });
  });

  it("uses dYdX when Hyperliquid is down and never asks Coinbase for candles", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sources?: string[] };
      const source = body.sources?.[0];
      if (source === "COINBASE") {
        return new Response("{}", { status: 429 });
      }
      if (String(input).endsWith("/internal/ticker")) {
        return Response.json({
          productId: "BTC-USD",
          price: 10,
          observedAt: 120_000,
          source: "dydx",
          cached: false,
        });
      }
      if (source === "HYPERLIQUID") return new Response("{}", { status: 503 });
      return Response.json({
        productId: "BTC-USD",
        timeframe: "ONE_MINUTE",
        candles: [candle(60_000, 10)],
        source: "dydx",
        cached: false,
      });
    });
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe("dydx");
    expect(result.value.valuationMark?.source).toBe("DYDX_CANDLE_CLOSE");
    const requested = fetch.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)).sources,
    );
    expect(requested).toEqual([["HYPERLIQUID"], ["DYDX"], ["DYDX"]]);
  });

  it("fails closed when the internal secret is missing", async () => {
    const fetch = vi.fn();
    const result = await fetchMarketSnapshot(
      { fetch },
      "short",
      configuration(),
      120_000,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "AUTHENTICATION_FAILURE",
        retryable: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a market worker 401 to AUTHENTICATION_FAILURE, not a network error", async () => {
    const fetch = marketFetch(
      new Response("{\"error\":{\"code\":\"UNAUTHORIZED\"}}", { status: 401 }),
      tickerResponse(10),
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "AUTHENTICATION_FAILURE",
        retryable: false,
      },
    });
  });

  it("reports both decision sources down as MARKET_SOURCES_EXHAUSTED", async () => {
    const fetch = marketFetch(
      new Response("{}", { status: 503 }),
      tickerResponse(10),
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      120_500,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "MARKET_SOURCES_EXHAUSTED",
        retryable: true,
      },
    });
  });

  it("rejects a gappy series from every decision source", async () => {
    const fetch = marketFetch(
      // 60_000 manquant au milieu de la série.
      candlesResponse([candle(0), candle(120_000)]),
      tickerResponse(10),
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      120_500,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "MARKET_SOURCES_EXHAUSTED",
        retryable: true,
      },
    });
  });

  it("rejects a ticker diverging beyond the frozen tolerance (dao #25)", async () => {
    const fetch = marketFetch(
      candlesResponse([candle(60_000)]),
      tickerResponse(10.2), // 200 bps > 100 bps
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      120_500,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "MARKET_SOURCES_EXHAUSTED",
        retryable: true,
      },
    });
  });

  it("fails closed when the ticker is unreachable (dao #25)", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/internal/ticker")) {
        throw new TypeError("network down");
      }
      return candlesResponse([candle(60_000)]);
    });
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      120_500,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "MARKET_SOURCES_EXHAUSTED",
        retryable: true,
      },
    });
  });

  it("does not let a Coinbase 429 decide the candle source", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sources?: string[] };
      if (body.sources?.[0] === "COINBASE") {
        return new Response("{}", { status: 429, headers: { "retry-after": "9" } });
      }
      return String(input).endsWith("/internal/ticker")
        ? tickerResponse(10)
        : candlesResponse([candle(60_000)]);
    });
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      120_500,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe("hyperliquid");
    expect(result.value.valuationMark?.source).toBe("HYPERLIQUID_CANDLE_CLOSE");
  });

  it("qualifies exhaustion as non retryable when no retry can finish before the decision deadline", async () => {
    const fetch = marketFetch(
      new Response("{}", { status: 429 }),
      tickerResponse(10),
    );
    // ONE_MINUTE, fraîcheur 90 s : bougie de décision close à 120 s, échéance 210 s.
    // now = 200 s ⇒ premier retry (≥ 60 s) après l'échéance.
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
      200_000,
    );
    expect(result).toEqual({
      ok: false,
      error: { phase: "market-data", code: "MARKET_SOURCES_EXHAUSTED", retryable: false },
    });
  });
});
