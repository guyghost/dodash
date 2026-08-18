import {
  createCandle,
  createProductId,
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type Result,
  type Timeframe,
} from "@dodash/domain";
import type { WorkflowError } from "@dodash/models";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import type { AgentConfiguration } from "./configuration.js";
import type { MarketSnapshot } from "./types.js";

const MAX_MARKET_RESPONSE_BYTES = 1_000_000;

const timeframeMilliseconds: Readonly<Record<Timeframe, number>> = Object.freeze({
  ONE_MINUTE: 60_000,
  FIVE_MINUTE: 300_000,
  FIFTEEN_MINUTE: 900_000,
  ONE_HOUR: 3_600_000,
  SIX_HOUR: 21_600_000,
  ONE_DAY: 86_400_000,
});

const responseSchema = z.object({
  productId: z.string(),
  timeframe: z.enum([
    "ONE_MINUTE",
    "FIVE_MINUTE",
    "FIFTEEN_MINUTE",
    "ONE_HOUR",
    "SIX_HOUR",
    "ONE_DAY",
  ]),
  candles: z.array(
    z.object({
      start: z.number().int().nonnegative(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
      volume: z.number(),
    }),
  ),
  source: z.literal("coinbase"),
  cached: z.boolean(),
});

const error = (
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase: "market-data", code, retryable });

export interface MarketService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const fetchMarketSnapshot = async (
  service: MarketService,
  internalToken: string,
  configuration: AgentConfiguration,
  triggeredAt: number,
): Promise<Result<MarketSnapshot, WorkflowError>> => {
  if (internalToken.length < 32) {
    return err(error("NETWORK_UNAVAILABLE", false));
  }

  const duration = timeframeMilliseconds[configuration.timeframe];
  const closedBoundary = Math.floor(triggeredAt / duration) * duration;
  let response: Response;
  try {
    response = await service.fetch("https://market-data/internal/candles", {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        productId: configuration.productId,
        timeframe: configuration.timeframe,
        limit: configuration.candleLimit,
        end: Math.floor(closedBoundary / 1_000),
      }),
    });
  } catch {
    return err(error("NETWORK_UNAVAILABLE", true));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return err(
      response.status === 429
        ? error("RATE_LIMITED", true)
        : error("NETWORK_UNAVAILABLE", response.status >= 500),
    );
  }

  try {
    const json = await readBoundedJson(response, MAX_MARKET_RESPONSE_BYTES);
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) return err(error("INVALID_RESPONSE", false));

    const product = createProductId(parsed.data.productId);
    if (
      !product.ok ||
      product.value !== configuration.productId ||
      parsed.data.timeframe !== configuration.timeframe
    ) {
      return err(error("INVALID_RESPONSE", false));
    }
    const candles: Candle[] = [];
    for (const raw of parsed.data.candles) {
      const candle = createCandle(raw);
      if (!candle.ok) return err(error("INVALID_RESPONSE", false));
      candles.push(candle.value);
    }
    const series = validateCandleSeries(candles);
    if (!series.ok) return err(error("INVALID_RESPONSE", false));

    return ok(
      Object.freeze({
        productId: product.value,
        timeframe: parsed.data.timeframe,
        candles: series.value,
        source: parsed.data.source,
        cached: parsed.data.cached,
      }),
    );
  } catch {
    return err(error("INVALID_RESPONSE", false));
  }
};
