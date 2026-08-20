import {
  createCandle,
  createProductId,
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type ProductId,
  type Result,
  type Timeframe,
} from "@dodash/domain";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import type { CandleRequest, TickerRequest } from "./contracts.js";

const MAX_COINBASE_RESPONSE_BYTES = 1_000_000;

const timeframeSeconds: Readonly<Record<Timeframe, number>> = Object.freeze({
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  ONE_HOUR: 3_600,
  SIX_HOUR: 21_600,
  ONE_DAY: 86_400,
});

const numberLikeSchema = z
  .union([z.string(), z.number()])
  .transform((value, context) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      context.addIssue({ code: "custom", message: "Expected a finite number" });
      return z.NEVER;
    }
    return parsed;
  });

const coinbaseCandleSchema = z.object({
  start: numberLikeSchema,
  low: numberLikeSchema,
  high: numberLikeSchema,
  open: numberLikeSchema,
  close: numberLikeSchema,
  volume: numberLikeSchema,
});

const coinbaseCandleResponseSchema = z.object({
  candles: z.array(coinbaseCandleSchema).max(350),
});

const coinbaseTickerResponseSchema = z.object({
  price: numberLikeSchema,
});

export interface MarketCache {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options: { readonly expirationTtl: number },
  ): Promise<void>;
}

export type MarketDataError =
  | { readonly code: "INVALID_REQUEST" }
  | { readonly code: "INVALID_RESPONSE" }
  | { readonly code: "NETWORK_UNAVAILABLE" }
  | { readonly code: "RATE_LIMITED"; readonly retryAfterSeconds?: number }
  | { readonly code: "UPSTREAM_UNAVAILABLE"; readonly status: number };

export interface CandleSnapshot {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly source: "coinbase";
  readonly cached: boolean;
}

export interface TickerSnapshot {
  readonly productId: ProductId;
  readonly price: number;
  readonly observedAt: number;
  readonly source: "coinbase";
  readonly cached: boolean;
}

export interface CoinbaseMarketDataOptions {
  readonly baseUrl: string;
  readonly cache: MarketCache;
  readonly cacheTtlSeconds: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const parseRetryAfter = (response: Response): number | undefined => {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
};

const responseError = (response: Response): MarketDataError => {
  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfter(response);
    return retryAfterSeconds === undefined
      ? { code: "RATE_LIMITED" }
      : { code: "RATE_LIMITED", retryAfterSeconds };
  }
  return { code: "UPSTREAM_UNAVAILABLE", status: response.status };
};

const normalizeBaseUrl = (raw: string): string => raw.replace(/\/$/, "");

const parseCached = <T>(raw: string | null): T | undefined => {
  if (raw === null || raw.length > MAX_COINBASE_RESPONSE_BYTES) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export class CoinbaseMarketData {
  readonly #baseUrl: string;
  readonly #cache: MarketCache;
  readonly #cacheTtlSeconds: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: CoinbaseMarketDataOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#cache = options.cache;
    this.#cacheTtlSeconds = Math.max(
      1,
      Math.min(3_600, Math.floor(options.cacheTtlSeconds)),
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async getCandles(
    request: CandleRequest,
  ): Promise<Result<CandleSnapshot, MarketDataError>> {
    const productResult = createProductId(request.productId);
    if (!productResult.ok || request.limit < 1 || request.limit > 350) {
      return err({ code: "INVALID_REQUEST" });
    }

    const duration = timeframeSeconds[request.timeframe];
    const end = request.end ?? Math.floor(this.#now() / 1_000);
    const start = end - duration * request.limit;
    if (!Number.isSafeInteger(end) || start < 0) {
      return err({ code: "INVALID_REQUEST" });
    }

    const cacheKey = [
      "market",
      "candles",
      "v2",
      productResult.value,
      request.timeframe,
      start,
      end,
      request.limit,
    ].join(":");
    const cached = parseCached<Omit<CandleSnapshot, "cached">>(
      await this.#cache.get(cacheKey).catch(() => null),
    );
    if (cached !== undefined) {
      const validation = validateCandleSeries(cached.candles);
      if (
        validation.ok &&
        cached.productId === productResult.value &&
        cached.timeframe === request.timeframe &&
        cached.source === "coinbase"
      ) {
        return ok(Object.freeze({ ...cached, candles: validation.value, cached: true }));
      }
    }

    const url = new URL(
      `${this.#baseUrl}/api/v3/brokerage/market/products/${encodeURIComponent(productResult.value)}/candles`,
    );
    url.searchParams.set("start", String(start));
    url.searchParams.set("end", String(end));
    url.searchParams.set("granularity", request.timeframe);
    url.searchParams.set("limit", String(request.limit));

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (caught) {
      console.warn(
        JSON.stringify({
          event: "coinbase_candles_fetch_failed",
          errorType: caught instanceof Error ? caught.name : "UnknownError",
        }),
      );
      return err({ code: "NETWORK_UNAVAILABLE" });
    }

    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "coinbase_candles_response_failed",
          status: response.status,
        }),
      );
      const error = responseError(response);
      await response.body?.cancel().catch(() => undefined);
      return err(error);
    }

    let parsed: z.infer<typeof coinbaseCandleResponseSchema>;
    try {
      const json = await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES);
      const result = coinbaseCandleResponseSchema.safeParse(json);
      if (!result.success) return err({ code: "INVALID_RESPONSE" });
      parsed = result.data;
    } catch {
      return err({ code: "INVALID_RESPONSE" });
    }

    const candles: Candle[] = [];
    for (const raw of parsed.candles) {
      const candleResult = createCandle({
        start: raw.start * 1_000,
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: raw.volume,
      });
      if (!candleResult.ok) return err({ code: "INVALID_RESPONSE" });
      candles.push(candleResult.value);
    }
    candles.sort((left, right) => left.start - right.start);

    const seriesResult = validateCandleSeries(candles);
    if (!seriesResult.ok) return err({ code: "INVALID_RESPONSE" });

    const snapshot = Object.freeze({
      productId: productResult.value,
      timeframe: request.timeframe,
      candles: seriesResult.value,
      source: "coinbase" as const,
      cached: false,
    });
    const cacheValue = JSON.stringify({
      productId: snapshot.productId,
      timeframe: snapshot.timeframe,
      candles: snapshot.candles,
      source: snapshot.source,
    });
    const expirationTtl = Math.min(
      this.#cacheTtlSeconds,
      Math.max(1, duration - 1),
    );
    await this.#cache
      .put(cacheKey, cacheValue, { expirationTtl })
      .catch(() => undefined);
    return ok(snapshot);
  }

  async getTicker(
    request: TickerRequest,
  ): Promise<Result<TickerSnapshot, MarketDataError>> {
    const productResult = createProductId(request.productId);
    if (!productResult.ok) return err({ code: "INVALID_REQUEST" });

    const cacheKey = `market:ticker:v1:${productResult.value}`;
    const cached = parseCached<Omit<TickerSnapshot, "cached">>(
      await this.#cache.get(cacheKey).catch(() => null),
    );
    if (
      cached !== undefined &&
      cached.productId === productResult.value &&
      Number.isFinite(cached.price) &&
      cached.price > 0 &&
      Number.isSafeInteger(cached.observedAt) &&
      cached.source === "coinbase"
    ) {
      return ok(Object.freeze({ ...cached, cached: true }));
    }

    const url = new URL(
      `${this.#baseUrl}/api/v3/brokerage/market/products/${encodeURIComponent(productResult.value)}`,
    );
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return err({ code: "NETWORK_UNAVAILABLE" });
    }
    if (!response.ok) {
      const error = responseError(response);
      await response.body?.cancel().catch(() => undefined);
      return err(error);
    }

    try {
      const json = await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES);
      const parsed = coinbaseTickerResponseSchema.safeParse(json);
      if (!parsed.success || parsed.data.price <= 0) {
        return err({ code: "INVALID_RESPONSE" });
      }
      const snapshot = Object.freeze({
        productId: productResult.value,
        price: parsed.data.price,
        observedAt: Math.floor(this.#now() / 1_000),
        source: "coinbase" as const,
        cached: false,
      });
      await this.#cache
        .put(
          cacheKey,
          JSON.stringify({
            productId: snapshot.productId,
            price: snapshot.price,
            observedAt: snapshot.observedAt,
            source: snapshot.source,
          }),
          { expirationTtl: this.#cacheTtlSeconds },
        )
        .catch(() => undefined);
      return ok(snapshot);
    } catch {
      return err({ code: "INVALID_RESPONSE" });
    }
  }
}
