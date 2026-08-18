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
});
