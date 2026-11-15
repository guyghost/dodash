/**
 * Canonical paper valuation projection (DAO #62).
 *
 * This is a measurement model only. It does not feed daily-risk or admission
 * decisions; callers must pass the close timestamp of the market candle that
 * supplied the mark, never the acquisition price or cycle trigger time.
 */
export type PaperValuationQuality = "fresh" | "stale" | "unavailable";

/**
 * Closed label of the candle close that supplied the mark. One series, one
 * source. A ticker, mid, or book is never a mark.
 */
export const CANDLE_CLOSE_MARK_SOURCES = Object.freeze([
  "COINBASE_CANDLE_CLOSE",
  "HYPERLIQUID_CANDLE_CLOSE",
  "DYDX_CANDLE_CLOSE",
] as const);

export type CandleCloseMarkSource = (typeof CANDLE_CLOSE_MARK_SOURCES)[number];

export const isCandleCloseMarkSource = (
  value: unknown,
): value is CandleCloseMarkSource =>
  value === "COINBASE_CANDLE_CLOSE" ||
  value === "HYPERLIQUID_CANDLE_CLOSE" ||
  value === "DYDX_CANDLE_CLOSE";

export interface PaperValuationMark {
  readonly price: number;
  readonly source: CandleCloseMarkSource;
  readonly timeframe: string;
  readonly candleClosedAt: number;
  /** Configuration policy captured with this immutable price observation. */
  readonly maxMarketStalenessMs: number;
}

export interface PaperValuationInput {
  readonly cash: number;
  readonly positionQuantity: number;
  readonly mark: PaperValuationMark | null;
  readonly asOf: number;
}

export interface PaperValuation {
  readonly asOf: number;
  readonly equity: number | null;
  readonly exposureNotional: number | null;
  readonly exposureQuality: PaperValuationQuality;
  readonly markPrice: number | null;
  readonly markSource: PaperValuationMark["source"] | null;
  readonly timeframe: string | null;
  readonly candleClosedAt: number | null;
  readonly ageMs: number | null;
  readonly quality: PaperValuationQuality;
}

export type PaperValuationErrorCode =
  | "INVALID_PORTFOLIO"
  | "INVALID_AS_OF"
  | "INVALID_MARK"
  | "VALUATION_OVERFLOW";

export type PaperValuationResult =
  | { readonly ok: true; readonly value: PaperValuation }
  | {
      readonly ok: false;
      readonly error: { readonly code: PaperValuationErrorCode };
    };

const isSafeTime = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const isValidPaperValuationMark = (
  value: unknown,
): value is PaperValuationMark =>
  typeof value === "object" &&
  value !== null &&
  "price" in value &&
  typeof value.price === "number" &&
  Number.isFinite(value.price) &&
  value.price > 0 &&
  "source" in value &&
  isCandleCloseMarkSource(value.source) &&
  "timeframe" in value &&
  typeof value.timeframe === "string" &&
  value.timeframe.trim().length > 0 &&
  "candleClosedAt" in value &&
  typeof value.candleClosedAt === "number" &&
  isSafeTime(value.candleClosedAt) &&
  "maxMarketStalenessMs" in value &&
  typeof value.maxMarketStalenessMs === "number" &&
  Number.isSafeInteger(value.maxMarketStalenessMs) &&
  value.maxMarketStalenessMs > 0;

/** Validates, copies, and freezes a persisted paper valuation mark. */
export const normalizePaperValuationMark = (
  value: unknown,
): PaperValuationMark | null => {
  if (!isValidPaperValuationMark(value)) return null;
  return Object.freeze({
    price: value.price,
    source: value.source,
    timeframe: value.timeframe,
    candleClosedAt: value.candleClosedAt,
    maxMarketStalenessMs: value.maxMarketStalenessMs,
  });
};

/** Accepts a new mark or preserves only a revalidated previous mark. */
export const acceptPaperValuationMark = (
  candidate: unknown,
  previous: unknown,
): PaperValuationMark | null =>
  normalizePaperValuationMark(candidate) ??
  normalizePaperValuationMark(previous);

/**
 * Computes paper equity from cash and a dated market mark.
 *
 * A stale mark remains a usable historical estimate only when it is explicitly
 * labelled stale. With an open position, no mark produces `equity: null`;
 * acquisition cost is never a substitute. Fees are already reflected in
 * post-fill cash and must not be subtracted a second time here.
 */
export const projectPaperValuation = (
  input: PaperValuationInput,
): PaperValuationResult => {
  if (
    !Number.isFinite(input.cash) ||
    input.cash < 0 ||
    !Number.isFinite(input.positionQuantity) ||
    input.positionQuantity < 0
  ) {
    return { ok: false, error: { code: "INVALID_PORTFOLIO" } };
  }
  if (!isSafeTime(input.asOf)) {
    return { ok: false, error: { code: "INVALID_AS_OF" } };
  }
  if (input.mark === null) {
    return {
      ok: true,
      value: Object.freeze({
        asOf: input.asOf,
        equity: input.positionQuantity === 0 ? input.cash : null,
        exposureNotional: input.positionQuantity === 0 ? 0 : null,
        exposureQuality: input.positionQuantity === 0 ? "fresh" : "unavailable",
        markPrice: null,
        markSource: null,
        timeframe: null,
        candleClosedAt: null,
        ageMs: null,
        quality: "unavailable",
      }),
    };
  }

  if (!isValidPaperValuationMark(input.mark) || input.mark.candleClosedAt > input.asOf) {
    return { ok: false, error: { code: "INVALID_MARK" } };
  }

  const equity =
    input.cash + input.positionQuantity * input.mark.price;
  const exposureNotional = Math.abs(input.positionQuantity) * input.mark.price;
  if (!Number.isFinite(equity) || !Number.isFinite(exposureNotional)) {
    return { ok: false, error: { code: "VALUATION_OVERFLOW" } };
  }

  const ageMs = input.asOf - input.mark.candleClosedAt;
  return {
    ok: true,
    value: Object.freeze({
      asOf: input.asOf,
      equity,
      exposureNotional,
      exposureQuality:
        input.positionQuantity === 0 ? "fresh" : ageMsQuality(input, ageMs),
      markPrice: input.mark.price,
      markSource: input.mark.source,
      timeframe: input.mark.timeframe,
      candleClosedAt: input.mark.candleClosedAt,
      ageMs,
      quality: ageMsQuality(input, ageMs),
    }),
  };
};

const ageMsQuality = (
  input: PaperValuationInput,
  ageMs: number,
): PaperValuationQuality =>
  input.mark !== null && ageMs <= input.mark.maxMarketStalenessMs
    ? "fresh"
    : "stale";
