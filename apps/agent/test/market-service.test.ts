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
    source: "coinbase",
    cached: false,
  });

const tickerResponse = (price: number) =>
  Response.json({
    productId: "BTC-USD",
    price,
    observedAt: 120_000,
    source: "coinbase",
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
    expect(JSON.parse(String(tickerInit.body))).toEqual({
      productId: "BTC-USD",
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
        code: "NETWORK_UNAVAILABLE",
        retryable: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a gappy series with INVALID_RESPONSE (dao #25)", async () => {
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
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "INVALID_RESPONSE",
        retryable: false,
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
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "STALE_MARKET_DATA",
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
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "market-data",
        code: "NETWORK_UNAVAILABLE",
        retryable: true,
      },
    });
  });
});
