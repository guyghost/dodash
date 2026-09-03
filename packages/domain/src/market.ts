import { err, ok, type Result } from "./result.js";

declare const productIdBrand: unique symbol;
export type ProductId = string & { readonly [productIdBrand]: true };

export const TIMEFRAMES = [
  "ONE_MINUTE",
  "FIVE_MINUTE",
  "FIFTEEN_MINUTE",
  "ONE_HOUR",
  "SIX_HOUR",
  "ONE_DAY",
] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Candle {
  readonly start: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export type MarketValidationError =
  | { readonly code: "INVALID_PRODUCT_ID" }
  | { readonly code: "INVALID_TIMESTAMP" }
  | { readonly code: "INVALID_PRICE"; readonly field: "open" | "high" | "low" | "close" }
  | { readonly code: "INVALID_VOLUME" }
  | { readonly code: "INVALID_OHLC_RANGE" }
  | { readonly code: "EMPTY_CANDLE_SERIES" }
  | { readonly code: "UNSORTED_CANDLE_SERIES"; readonly index: number }
  | { readonly code: "DUPLICATE_CANDLE"; readonly index: number };

// INV-I2 (models/market-data-integrity.md) : table canonique des durées,
// source unique — aucune constante divergente ailleurs dans le code.
export const TIMEFRAME_MILLISECONDS: Readonly<Record<Timeframe, number>> =
  Object.freeze({
    ONE_MINUTE: 60_000,
    FIVE_MINUTE: 300_000,
    FIFTEEN_MINUTE: 900_000,
    ONE_HOUR: 3_600_000,
    SIX_HOUR: 21_600_000,
    ONE_DAY: 86_400_000,
  });

// INV-I2 (models/market-data-integrity.md §3) : tolérance de cohérence
// ticker figée par le modèle — valeur unique, jamais recalée localement.
export const MAX_TICKER_DIVERGENCE_BPS = 100;

export type MarketDataIntegrityError =
  | { readonly code: "INVALID_INTERVAL" }
  | { readonly code: "INVALID_SERIES"; readonly cause: MarketValidationError }
  | {
      readonly code: "CANDLE_GAP";
      readonly index: number;
      readonly expectedIntervalMs: number;
    }
  | { readonly code: "TICKER_INVALID_PRICE" }
  | {
      readonly code: "TICKER_INCOHERENT";
      readonly divergenceBps: number;
      readonly maxDivergenceBps: number;
    };

const assetPattern = /^[A-Z0-9]{2,15}$/;

export const createProductId = (
  raw: string,
): Result<ProductId, MarketValidationError> => {
  const normalized = raw.trim().toUpperCase();
  const parts = normalized.split("-");
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !assetPattern.test(parts[0]) ||
    !assetPattern.test(parts[1]) ||
    parts[0] === parts[1]
  ) {
    return err({ code: "INVALID_PRODUCT_ID" });
  }
  return ok(normalized as ProductId);
};

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

export const createCandle = (
  input: Candle,
): Result<Candle, MarketValidationError> => {
  if (!Number.isSafeInteger(input.start) || input.start < 0) {
    return err({ code: "INVALID_TIMESTAMP" });
  }

  for (const field of ["open", "high", "low", "close"] as const) {
    if (!isPositiveFinite(input[field])) {
      return err({ code: "INVALID_PRICE", field });
    }
  }

  if (!Number.isFinite(input.volume) || input.volume < 0) {
    return err({ code: "INVALID_VOLUME" });
  }

  if (
    input.high < Math.max(input.open, input.close, input.low) ||
    input.low > Math.min(input.open, input.close, input.high)
  ) {
    return err({ code: "INVALID_OHLC_RANGE" });
  }

  return ok(Object.freeze({ ...input }));
};

export const validateCandleSeries = (
  candles: readonly Candle[],
): Result<readonly Candle[], MarketValidationError> => {
  if (candles.length === 0) return err({ code: "EMPTY_CANDLE_SERIES" });

  const validated: Candle[] = [];
  for (const [index, candle] of candles.entries()) {
    const result = createCandle(candle);
    if (!result.ok) return result;

    const previous = validated.at(-1);
    if (previous !== undefined && candle.start === previous.start) {
      return err({ code: "DUPLICATE_CANDLE", index });
    }
    if (previous !== undefined && candle.start < previous.start) {
      return err({ code: "UNSORTED_CANDLE_SERIES", index });
    }
    validated.push(result.value);
  }

  return ok(Object.freeze(validated));
};

// INV-I3/INV-I5 (models/market-data-integrity.md) : validation pure et
// déterministe, ordre figé intervalle → structure → continuité → ticker,
// premier échec gagnant avec index de la bougie fautive. Aucune bougie
// synthétique ni interpolation (INV-I1) : toute série douteuse est
// rejetée. `ticker: null` n'est licite qu'au rejeu (INV-I7).
export const validateMarketDataIntegrity = (
  candles: readonly Candle[],
  intervalMs: number,
  ticker: { readonly price: number } | null,
): Result<readonly Candle[], MarketDataIntegrityError> => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    return err({ code: "INVALID_INTERVAL" });
  }

  const series = validateCandleSeries(candles);
  if (!series.ok) return err({ code: "INVALID_SERIES", cause: series.error });

  let previous: Candle | undefined;
  let index = 0;
  for (const candle of series.value) {
    if (
      previous !== undefined &&
      candle.start - previous.start !== intervalMs
    ) {
      return err({
        code: "CANDLE_GAP",
        index,
        expectedIntervalMs: intervalMs,
      });
    }
    previous = candle;
    index += 1;
  }

  const last = series.value.at(-1);
  if (ticker !== null && last !== undefined) {
    if (!Number.isFinite(ticker.price) || ticker.price <= 0) {
      return err({ code: "TICKER_INVALID_PRICE" });
    }
    const divergenceBps =
      (Math.abs(ticker.price - last.close) / last.close) * 10_000;
    if (divergenceBps > MAX_TICKER_DIVERGENCE_BPS) {
      return err({
        code: "TICKER_INCOHERENT",
        divergenceBps,
        maxDivergenceBps: MAX_TICKER_DIVERGENCE_BPS,
      });
    }
  }

  return series;
};

