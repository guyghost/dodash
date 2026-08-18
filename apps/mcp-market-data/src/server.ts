import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CoinbaseMarketData, MarketDataError } from "./coinbase.js";
import { candleRequestSchema, tickerRequestSchema } from "./contracts.js";

const errorMessage = (error: MarketDataError): string => {
  switch (error.code) {
    case "INVALID_REQUEST":
      return "The market data request is invalid.";
    case "INVALID_RESPONSE":
      return "Coinbase returned data that failed validation.";
    case "NETWORK_UNAVAILABLE":
      return "Coinbase is currently unreachable.";
    case "RATE_LIMITED":
      return error.retryAfterSeconds === undefined
        ? "Coinbase rate limited the request."
        : `Coinbase rate limited the request; retry after ${error.retryAfterSeconds} seconds.`;
    case "UPSTREAM_UNAVAILABLE":
      return `Coinbase returned HTTP ${error.status}.`;
  }
};

const toolError = (error: MarketDataError) => ({
  content: [{ type: "text" as const, text: errorMessage(error) }],
  isError: true as const,
});

export const createMarketMcpServer = (market: CoinbaseMarketData): McpServer => {
  const server = new McpServer({
    name: "dodash-market-data",
    version: "0.1.0",
  });

  server.registerTool(
    "get_candles",
    {
      title: "Get Coinbase candles",
      description:
        "Fetch a validated, ascending Coinbase candle series for one product and timeframe.",
      inputSchema: candleRequestSchema,
      outputSchema: z.object({
        productId: z.string(),
        timeframe: z.string(),
        candles: z.array(
          z.object({
            start: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          }),
        ),
        source: z.literal("coinbase"),
        cached: z.boolean(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const result = await market.getCandles(input);
      if (!result.ok) return toolError(result.error);
      const output = result.value;
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_ticker",
    {
      title: "Get Coinbase ticker",
      description: "Fetch the latest validated Coinbase price for one product.",
      inputSchema: tickerRequestSchema,
      outputSchema: z.object({
        productId: z.string(),
        price: z.number(),
        observedAt: z.number().int(),
        source: z.literal("coinbase"),
        cached: z.boolean(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const result = await market.getTicker(input);
      if (!result.ok) return toolError(result.error);
      const output = result.value;
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
};
