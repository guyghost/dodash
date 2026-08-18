import { createMcpHandler } from "agents/mcp/server";

import { readBoundedJson } from "./bounded-json.js";
import {
  CoinbaseMarketData,
  type MarketDataError,
} from "./coinbase.js";
import { candleRequestSchema, tickerRequestSchema } from "./contracts.js";
import { createMarketMcpServer } from "./server.js";

const MAX_INTERNAL_REQUEST_BYTES = 16_384;

interface MarketDataEnv extends Env {
  readonly INTERNAL_SERVICE_TOKEN: string;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const constantTimeEqual = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

const createMarket = (env: MarketDataEnv): CoinbaseMarketData =>
  new CoinbaseMarketData({
    baseUrl: env.COINBASE_API_BASE_URL,
    cache: env.MARKET_CACHE,
    cacheTtlSeconds: Number(env.MARKET_CACHE_TTL_SECONDS),
  });

const isAuthorizedInternalRequest = (
  request: Request,
  env: MarketDataEnv,
): boolean => {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const expectedToken = env.INTERNAL_SERVICE_TOKEN;
  return (
    token !== undefined &&
    typeof expectedToken === "string" &&
    expectedToken.length >= 32 &&
    constantTimeEqual(token, expectedToken)
  );
};

const marketErrorStatus = (error: MarketDataError): number => {
  switch (error.code) {
    case "INVALID_REQUEST":
      return 400;
    case "RATE_LIMITED":
      return 429;
    case "NETWORK_UNAVAILABLE":
      return 503;
    case "INVALID_RESPONSE":
    case "UPSTREAM_UNAVAILABLE":
      return 502;
  }
};

const handleInternalRequest = async (
  request: Request,
  env: MarketDataEnv,
  kind: "candles" | "ticker",
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  if (!isAuthorizedInternalRequest(request, env)) {
    return json({ error: { code: "UNAUTHORIZED" } }, 401);
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_INTERNAL_REQUEST_BYTES);
  } catch {
    return json({ error: { code: "INVALID_REQUEST" } }, 400);
  }

  const market = createMarket(env);
  if (kind === "candles") {
    const parsed = candleRequestSchema.safeParse(body);
    if (!parsed.success) return json({ error: { code: "INVALID_REQUEST" } }, 400);
    const result = await market.getCandles(parsed.data);
    return result.ok
      ? json(result.value)
      : json({ error: result.error }, marketErrorStatus(result.error));
  }

  const parsed = tickerRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: { code: "INVALID_REQUEST" } }, 400);
  const result = await market.getTicker(parsed.data);
  return result.ok
    ? json(result.value)
    : json({ error: result.error }, marketErrorStatus(result.error));
};

export const handleWorkerRequest = async (
  request: Request,
  env: MarketDataEnv,
  ctx: ExecutionContext,
): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    return json({ status: "ok", service: "dodash-mcp-market-data" });
  }
  if (pathname === "/internal/candles") {
    return handleInternalRequest(request, env, "candles");
  }
  if (pathname === "/internal/ticker") {
    return handleInternalRequest(request, env, "ticker");
  }
  if (pathname === "/mcp") {
    const handler = createMcpHandler(
      () => createMarketMcpServer(createMarket(env)),
      {
        route: "/mcp",
        corsOptions: false,
        onerror: (error) => {
          console.error(
            JSON.stringify({
              event: "mcp_request_failed",
              errorType: error.name,
            }),
          );
        },
      },
    );
    return handler(request, env, ctx);
  }

  return new Response("Not Found", { status: 404 });
};

export default {
  fetch: handleWorkerRequest,
} satisfies ExportedHandler<MarketDataEnv>;
