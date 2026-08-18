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

