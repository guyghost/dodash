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

describe("fetchMarketSnapshot", () => {
  it("authenticates the service binding and revalidates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        productId: "BTC-USD",
        timeframe: "ONE_MINUTE",
        candles: [
          { start: 0, open: 10, high: 11, low: 9, close: 10, volume: 1 },
        ],
        source: "coinbase",
        cached: false,
      }),
    );
    const result = await fetchMarketSnapshot(
      { fetch },
      "x".repeat(32),
      configuration(),
      120_000,
    );

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${"x".repeat(32)}`,
    );
    expect(JSON.parse(String(init.body))).toMatchObject({ end: 120 });
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
});
