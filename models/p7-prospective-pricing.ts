import { evaluateP7ExecutionBook, isP7DepthBook, type P7QuoteScope } from "./p7-prospective-quote.js";

export type P7MarkScope = Omit<P7QuoteScope, "candleClosedAt" | "intentPersistedAt">;
type Rejected = { readonly ok: false; readonly reason: string };
export type P7DepthPrice = { readonly ok: true; readonly vwap: number; readonly notional: number; readonly quantity: number } | Rejected;
const reject = (reason: string): Rejected => ({ ok: false, reason });
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const sequence = (n: unknown): n is string => typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n) && n.length <= 64;
const record = (n: unknown): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n);
const validScope = (s: P7MarkScope, asOf: number): boolean => ["BTC-USD", "ETH-USD"].includes(s.productId) &&
  typeof s.sourceProfileId === "string" && s.sourceProfileId.trim().length > 0 &&
  [s.campaignStartAt, s.campaignEndAt, asOf].every(timestamp) && s.campaignStartAt % 86_400_000 === 0 &&
  s.campaignEndAt - s.campaignStartAt === 180 * 86_400_000 && asOf >= s.campaignStartAt && asOf <= s.campaignEndAt;

/** No partial fill and no epsilon invented depth. This alone does not prove freshness. */
export const consumeP7Depth = (book: unknown, side: "BUY" | "SELL", quantity: number): P7DepthPrice => {
  if (!positive(quantity) || !["BUY", "SELL"].includes(side)) return reject("INVALID_QUANTITY_OR_SIDE");
  if (!isP7DepthBook(book)) return reject("BOOK_INVALID");
  let remaining = quantity, notional = 0;
  for (const level of side === "BUY" ? book.asks : book.bids) {
    const take = Math.min(remaining, level.quantity), value = take * level.price;
    if (!positive(value) || !positive(notional + value) || notional + value === notional || remaining - take === remaining) return reject("NUMERIC_RANGE");
    notional += value;
    remaining -= take;
    if (remaining === 0) break;
  }
  if (remaining !== 0) return reject("INSUFFICIENT_DEPTH");
  const vwap = notional / quantity;
  return positive(vwap) ? { ok: true, vwap, notional, quantity } : reject("NUMERIC_RANGE");
};

const freshAtUse = (book: unknown, asOf: number): boolean => record(book) && timestamp(asOf) &&
  timestamp(book.receivedAt) && timestamp(book.sourceObservedAt) && asOf >= book.receivedAt &&
  book.sourceObservedAt <= book.receivedAt && asOf - book.sourceObservedAt <= 5_000;

export const planP7Pricing = (scope: P7QuoteScope, book: unknown, side: "BUY" | "SELL", quantity: number, asOf: number): P7DepthPrice => {
  const eligibility = evaluateP7ExecutionBook(scope, book);
  if (!eligibility.eligible) return reject(eligibility.reason);
  if (!freshAtUse(book, asOf)) return reject("STALE_AT_USE");
  if (asOf > scope.candleClosedAt + 7_200_000 || asOf >= scope.campaignEndAt) return reject("WINDOW_EXPIRED");
  return consumeP7Depth(book, side, quantity);
};

const markBookReason = (scope: P7MarkScope, book: unknown, asOf: number): string | null => {
  if (scope.clockVerified !== true) return "CLOCK_UNVERIFIED";
  if (!record(book) || book.productId !== scope.productId || book.sourceProfileId !== scope.sourceProfileId) return "IDENTITY_MISMATCH";
  if (book.cacheStatus !== "UNCACHED") return "CACHE_UNVERIFIED";
  if (!timestamp(book.requestedAt) || !timestamp(book.receivedAt) || book.requestedAt < scope.campaignStartAt ||
    book.receivedAt < book.requestedAt || book.receivedAt - book.requestedAt > 5_000 || book.receivedAt >= scope.campaignEndAt) return "INVALID_TIMELINE";
  if (!freshAtUse(book, asOf)) return "STALE_AT_USE";
  if (!sequence(book.sequence) || (scope.previousSequence !== null &&
    (!sequence(scope.previousSequence) || BigInt(book.sequence) < BigInt(scope.previousSequence)))) return "SEQUENCE_INVALID";
  return isP7DepthBook(book) ? null : "BOOK_INVALID";
};
export type P7LiquidationMark = { readonly productId: P7MarkScope["productId"]; readonly asOf: number } & (
  { readonly available: false; readonly equity: null; readonly reason: string } |
  { readonly available: true; readonly equity: number; readonly source: "CASH" | "SIMULATED_BID_LIQUIDATION";
    readonly estimatedExitFee: number; readonly liquidablePositionValue: number });

/** Projection only: never changes balances or generates a sell order. */
export const valueP7Liquidation = (scope: P7MarkScope, book: unknown,
  portfolio: { readonly cash: number; readonly positionQuantity: number }, asOf: number): P7LiquidationMark => {
  const base = { productId: scope.productId, asOf };
  const unavailable = (reason: string): P7LiquidationMark => ({ ...base, available: false, equity: null, reason });
  if (!validScope(scope, asOf)) return unavailable("INVALID_SCOPE");
  if (!record(portfolio) || typeof portfolio.cash !== "number" || !Number.isFinite(portfolio.cash) || portfolio.cash < 0 ||
    typeof portfolio.positionQuantity !== "number" || !Number.isFinite(portfolio.positionQuantity) || portfolio.positionQuantity < 0) return unavailable("INVALID_PORTFOLIO");
  if (portfolio.positionQuantity === 0) return { ...base, available: true, source: "CASH", equity: portfolio.cash, estimatedExitFee: 0, liquidablePositionValue: 0 };
  const reason = markBookReason(scope, book, asOf);
  if (reason !== null) return unavailable(reason);
  const price = consumeP7Depth(book, "SELL", portfolio.positionQuantity);
  if (!price.ok) return unavailable(price.reason);
  const notional = price.vwap * 0.9998 * portfolio.positionQuantity;
  const estimatedExitFee = notional * 0.006;
  const liquidablePositionValue = notional - estimatedExitFee, equity = portfolio.cash + liquidablePositionValue;
  if (!positive(notional) || !positive(estimatedExitFee) || !positive(liquidablePositionValue) || !Number.isFinite(equity)) return unavailable("NUMERIC_RANGE");
  return { ...base, available: true, source: "SIMULATED_BID_LIQUIDATION", estimatedExitFee, liquidablePositionValue, equity };
};

export const consolidateP7Marks = (marks: readonly P7LiquidationMark[]):
  { readonly available: true; readonly equity: number; readonly asOf: number } | { readonly available: false; readonly equity: null } => {
  const [first, second] = marks;
  if (marks.length !== 2 || !first?.available || !second?.available ||
    new Set(marks.map((m) => m.productId)).size !== 2 || !marks.every((m) => ["BTC-USD", "ETH-USD"].includes(m.productId)) ||
    first.asOf !== second.asOf || !timestamp(first.asOf) || ![first.equity, second.equity].every((n) => Number.isFinite(n) && n >= 0) ||
    !Number.isFinite(first.equity + second.equity)) return { available: false, equity: null };
  return { available: true, equity: first.equity + second.equity, asOf: first.asOf };
};
