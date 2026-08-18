import {
  createCandle,
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type ProductId,
  type Result,
  type Timeframe,
} from "@dodash/domain";

const DEFAULT_BASE_URL = "https://api.coinbase.com";
const MAX_PAGE_CANDLES = 350;
const MAX_RESPONSE_BYTES = 1_000_000;

const timeframeMs: Readonly<Record<Timeframe, number>> = Object.freeze({
  ONE_MINUTE: 60_000,
  FIVE_MINUTE: 300_000,
  FIFTEEN_MINUTE: 900_000,
  ONE_HOUR: 3_600_000,
  SIX_HOUR: 21_600_000,
  ONE_DAY: 86_400_000,
});

export interface CoinbaseHistoricalRequest {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly startAt: number;
  readonly endAt: number;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface HistoricalDataset {
  readonly datasetId: string;
  readonly sha256: string;
  readonly source: "coinbase";
  readonly endpoint: string;
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly startAt: number;
  readonly endAt: number;
  readonly candles: readonly Candle[];
}

export type CoinbaseHistoricalError =
  | { readonly code: "INVALID_HISTORICAL_REQUEST" }
  | { readonly code: "HISTORICAL_NETWORK_UNAVAILABLE" }
  | { readonly code: "HISTORICAL_UPSTREAM_ERROR"; readonly status: number }
  | { readonly code: "INVALID_HISTORICAL_RESPONSE" }
  | { readonly code: "INCOMPLETE_HISTORICAL_DATA" };

interface CoinbaseCandle {
  readonly start: number;
  readonly low: number;
  readonly high: number;
  readonly open: number;
  readonly close: number;
  readonly volume: number;
}

const finiteNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCoinbaseCandle = (value: unknown): CoinbaseCandle | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const start = finiteNumber(record.start);
  const low = finiteNumber(record.low);
  const high = finiteNumber(record.high);
  const open = finiteNumber(record.open);
  const close = finiteNumber(record.close);
  const volume = finiteNumber(record.volume);
  return start === null || low === null || high === null || open === null ||
      close === null || volume === null
    ? null
    : { start, low, high, open, close, volume };
};

const parseResponse = (raw: string): readonly CoinbaseCandle[] | null => {
  if (raw.length > MAX_RESPONSE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candles = (parsed as Record<string, unknown>).candles;
  if (!Array.isArray(candles) || candles.length > MAX_PAGE_CANDLES) return null;
  const normalized = candles.map(parseCoinbaseCandle);
  return normalized.some((item) => item === null)
    ? null
    : (normalized as readonly CoinbaseCandle[]);
};

const sha256 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const normalizeBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
};

export const loadCoinbaseHistoricalDataset = async (
  request: CoinbaseHistoricalRequest,
): Promise<Result<HistoricalDataset, CoinbaseHistoricalError>> => {
  const duration = timeframeMs[request.timeframe];
  const baseUrl = normalizeBaseUrl(request.baseUrl ?? DEFAULT_BASE_URL);
  if (
    duration === undefined ||
    baseUrl === null ||
    !Number.isSafeInteger(request.startAt) ||
    !Number.isSafeInteger(request.endAt) ||
    request.startAt < duration ||
    request.endAt <= request.startAt ||
    request.startAt % duration !== 0 ||
    request.endAt % duration !== 0
  ) {
    return err({ code: "INVALID_HISTORICAL_REQUEST" });
  }

  const candleCount = (request.endAt - request.startAt) / duration;
  if (!Number.isSafeInteger(candleCount) || candleCount < 1) {
    return err({ code: "INVALID_HISTORICAL_REQUEST" });
  }

  const endpoint = `${baseUrl}/api/v3/brokerage/market/products/${encodeURIComponent(request.productId)}/candles`;
  const fetcher = request.fetch ?? fetch;
  const candles: Candle[] = [];
  const timestamps = new Set<number>();

  for (
    let pageStart = request.startAt;
    pageStart < request.endAt;
    pageStart += MAX_PAGE_CANDLES * duration
  ) {
    const pageEnd = Math.min(
      request.endAt,
      pageStart + MAX_PAGE_CANDLES * duration,
    );
    const limit = (pageEnd - pageStart) / duration;
    const url = new URL(endpoint);
    url.searchParams.set("start", String((pageStart - duration) / 1_000));
    url.searchParams.set("end", String((pageEnd - duration) / 1_000));
    url.searchParams.set("granularity", request.timeframe);
    url.searchParams.set("limit", String(limit));

    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return err({ code: "HISTORICAL_NETWORK_UNAVAILABLE" });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return err({ code: "HISTORICAL_UPSTREAM_ERROR", status: response.status });
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      return err({ code: "INVALID_HISTORICAL_RESPONSE" });
    }
    const page = parseResponse(body);
    if (page === null) return err({ code: "INVALID_HISTORICAL_RESPONSE" });

    for (const raw of page) {
      const startedAt = raw.start * 1_000;
      if (!Number.isSafeInteger(startedAt) || timestamps.has(startedAt)) {
        return err({ code: "INCOMPLETE_HISTORICAL_DATA" });
      }
      const parsed = createCandle({
        start: startedAt,
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: raw.volume,
      });
      if (!parsed.ok) return err({ code: "INVALID_HISTORICAL_RESPONSE" });
      timestamps.add(startedAt);
      candles.push(parsed.value);
    }
  }

  candles.sort((left, right) => left.start - right.start);
  if (
    candles.length !== candleCount ||
    candles.some(
      (candle, index) => candle.start !== request.startAt + index * duration,
    )
  ) {
    return err({ code: "INCOMPLETE_HISTORICAL_DATA" });
  }
  const validated = validateCandleSeries(candles);
  if (!validated.ok) return err({ code: "INVALID_HISTORICAL_RESPONSE" });

  const canonical = JSON.stringify({
    source: "coinbase",
    endpoint,
    productId: request.productId,
    timeframe: request.timeframe,
    startAt: request.startAt,
    endAt: request.endAt,
    candles: validated.value,
  });
  const digest = await sha256(canonical);
  return ok(
    Object.freeze({
      datasetId: `coinbase:${request.productId}:${request.timeframe}:${request.startAt}:${request.endAt}:${digest}`,
      sha256: digest,
      source: "coinbase" as const,
      endpoint,
      productId: request.productId,
      timeframe: request.timeframe,
      startAt: request.startAt,
      endAt: request.endAt,
      candles: validated.value,
    }),
  );
};
