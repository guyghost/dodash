import {
  TIMEFRAME_MILLISECONDS,
  createCandle,
  createProductId,
  err,
  ok,
  validateMarketDataIntegrity,
  type Candle,
  type ProductId,
  type Result,
} from "@dodash/domain";
import { planMarketRetry, type WorkflowError } from "@dodash/models";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import type { AgentConfiguration } from "./configuration.js";
import type { MarketSnapshot } from "./types.js";

const MAX_MARKET_RESPONSE_BYTES = 1_000_000;

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

const tickerSchema = z.object({
  productId: z.string(),
  price: z.number(),
  observedAt: z.number().int().nonnegative(),
  source: z.literal("coinbase"),
  cached: z.boolean(),
});

const error = (
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase: "market-data", code, retryable });

// models/effects.md : classification fermée des réponses non-OK du binding
// marché — un refus d'authentification (401/403, secret partagé incorrect)
// n'est jamais une panne réseau et n'appelle aucun retry.
const parseRetryAfterMs = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
};

const responseError = (response: Response): WorkflowError => {
  const status = response.status;
  if (status === 401 || status === 403) {
    return error("AUTHENTICATION_FAILURE", false);
  }
  if (status === 429) {
    // effects.md (amendement 2026-09-28) : `Retry-After` amont porté en
    // diagnostic ; aucune garde ne le lit.
    const retryAfterMs = parseRetryAfterMs(response);
    return retryAfterMs === undefined
      ? error("RATE_LIMITED", true)
      : { ...error("RATE_LIMITED", true), retryAfterMs };
  }
  return error("NETWORK_UNAVAILABLE", status >= 500);
};

/**
 * Retryabilité à l'échéance (effects.md, amendement 2026-09-28) : une erreur
 * retryable dont le premier retry planifié ne pourrait aboutir avant la fin de
 * la fenêtre de fraîcheur de la bougie de décision est qualifiée non
 * retryable. Classification d'adapter ; la machine décide ensuite.
 */
export const qualifyMarketErrorRetryability = (
  workflowError: WorkflowError,
  configuration: AgentConfiguration,
  triggeredAt: number,
  now: number,
): WorkflowError => {
  if (!workflowError.retryable) return workflowError;
  const plan = planMarketRetry({
    attempt: 0,
    retryLimit: 1,
    retryable: true,
    retryAfterMs: workflowError.retryAfterMs ?? null,
    now,
    triggeredAt,
    timeframeMs: TIMEFRAME_MILLISECONDS[configuration.timeframe],
    maxMarketStalenessMs: configuration.maxMarketStalenessMs,
  });
  return plan.kind === "exhausted" && plan.reason === "DEADLINE"
    ? { ...workflowError, retryable: false }
    : workflowError;
};

const fetchTickerPrice = async (
  service: MarketService,
  internalToken: string,
  productId: ProductId,
): Promise<Result<number, WorkflowError>> => {
  let response: Response;
  try {
    response = await service.fetch("https://market-data/internal/ticker", {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ productId }),
    });
  } catch (caught) {
    console.warn(
      JSON.stringify({
        event: "market_service_ticker_fetch_failed",
        errorType: caught instanceof Error ? caught.name : "UnknownError",
      }),
    );
    return err(error("NETWORK_UNAVAILABLE", true));
  }

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        event: "market_service_ticker_response_failed",
        status: response.status,
      }),
    );
    await response.body?.cancel().catch(() => undefined);
    return err(responseError(response));
  }

  try {
    const json = await readBoundedJson(response, MAX_MARKET_RESPONSE_BYTES);
    const parsed = tickerSchema.safeParse(json);
    if (!parsed.success || parsed.data.productId !== productId) {
      return err(error("INVALID_RESPONSE", false));
    }
    return ok(parsed.data.price);
  } catch {
    return err(error("INVALID_RESPONSE", false));
  }
};

export interface MarketService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export const fetchMarketSnapshot = async (
  service: MarketService,
  internalToken: string,
  configuration: AgentConfiguration,
  triggeredAt: number,
  now: number = Date.now(),
): Promise<Result<MarketSnapshot, WorkflowError>> => {
  const result = await fetchMarketSnapshotUnqualified(
    service,
    internalToken,
    configuration,
    triggeredAt,
  );
  return result.ok
    ? result
    : err(qualifyMarketErrorRetryability(result.error, configuration, triggeredAt, now));
};

const fetchMarketSnapshotUnqualified = async (
  service: MarketService,
  internalToken: string,
  configuration: AgentConfiguration,
  triggeredAt: number,
): Promise<Result<MarketSnapshot, WorkflowError>> => {
  if (internalToken.length < 32) {
    return err(error("AUTHENTICATION_FAILURE", false));
  }

  const duration = TIMEFRAME_MILLISECONDS[configuration.timeframe];
  const currentBucketStart = Math.floor(triggeredAt / duration) * duration;
  const latestClosedStart = currentBucketStart - duration;
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
        end: Math.floor(latestClosedStart / 1_000),
      }),
    });
  } catch (caught) {
    console.warn(
      JSON.stringify({
        event: "market_service_fetch_failed",
        errorType: caught instanceof Error ? caught.name : "UnknownError",
      }),
    );
    return err(error("NETWORK_UNAVAILABLE", true));
  }

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        event: "market_service_response_failed",
        status: response.status,
      }),
    );
    await response.body?.cancel().catch(() => undefined);
    return err(responseError(response));
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

    // models/market-data-integrity.md §4.1 : point de branchement live —
    // avant MARKET_DATA_READY, donc avant computingIndicators. Mapping
    // des causes vers les codes fermés existants (table §3 du modèle).
    const ticker = await fetchTickerPrice(
      service,
      internalToken,
      configuration.productId,
    );
    if (!ticker.ok) return ticker;
    const integrity = validateMarketDataIntegrity(
      candles,
      duration,
      { price: ticker.value },
    );
    if (!integrity.ok) {
      console.warn(
        JSON.stringify({
          event: "market_service_integrity_failed",
          cause: integrity.error,
        }),
      );
      return err(
        integrity.error.code === "TICKER_INCOHERENT"
          ? error("STALE_MARKET_DATA", true)
          : error("INVALID_RESPONSE", false),
      );
    }

    const lastCandle = integrity.value.at(-1);
    if (lastCandle === undefined) return err(error("INVALID_RESPONSE", false));
    const candleClosedAt = lastCandle.start + duration;
    if (!Number.isSafeInteger(candleClosedAt)) {
      return err(error("INVALID_RESPONSE", false));
    }
    return ok(
      Object.freeze({
        productId: product.value,
        timeframe: parsed.data.timeframe,
        candles: integrity.value,
        source: parsed.data.source,
        cached: parsed.data.cached,
        valuationMark: Object.freeze({
          price: lastCandle.close,
          source: "COINBASE_CANDLE_CLOSE" as const,
          timeframe: parsed.data.timeframe,
          candleClosedAt,
          maxMarketStalenessMs: configuration.maxMarketStalenessMs,
        }),
      }),
    );
  } catch {
    return err(error("INVALID_RESPONSE", false));
  }
};
