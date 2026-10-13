/** Pure evidence gate; never produces a fill or changes the trading workflow. */
export interface P7QuoteScope {
  readonly productId: "BTC-USD" | "ETH-USD";
  readonly sourceProfileId: string;
  readonly clockVerified: boolean;
  readonly campaignStartAt: number;
  readonly campaignEndAt: number;
  readonly candleClosedAt: number;
  readonly intentPersistedAt: number;
  readonly previousSequence: string | null;
}
export type P7BookEligibility = { readonly eligible: true; readonly reason: "ELIGIBLE_BOOK" } | {
  readonly eligible: false;
  readonly reason: "INVALID_SCOPE" | "IDENTITY_MISMATCH" |
    "CLOCK_UNVERIFIED" | "CACHE_UNVERIFIED" | "INVALID_TIMELINE" |
    "SOURCE_TIME_UNAVAILABLE" | "SOURCE_TIME_INVALID" | "SEQUENCE_INVALID" | "BOOK_INVALID";
};
interface Level { readonly price: number; readonly quantity: number }
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const decimalSequence = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && /^(0|[1-9][0-9]*)$/.test(n);
const record = (n: unknown): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n);
const validSide = (levels: unknown, side: "bid" | "ask"): levels is readonly Level[] => {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 5_000) return false;
  let previous: number | null = null;
  for (const level of levels) {
    if (!record(level) || typeof level.price !== "number" || !Number.isFinite(level.price) || level.price <= 0 ||
      typeof level.quantity !== "number" || !Number.isFinite(level.quantity) || level.quantity <= 0) return false;
    if (previous !== null && (side === "bid" ? level.price >= previous : level.price <= previous)) return false;
    previous = level.price;
  }
  return true;
};

export const evaluateP7ExecutionBook = (scope: P7QuoteScope, book: unknown): P7BookEligibility => {
  const reject = (reason: Extract<P7BookEligibility, { eligible: false }>["reason"]): P7BookEligibility => ({ eligible: false, reason });
  if (!["BTC-USD", "ETH-USD"].includes(scope.productId) || typeof scope.sourceProfileId !== "string" || scope.sourceProfileId.trim().length === 0 ||
    ![scope.campaignStartAt, scope.campaignEndAt, scope.candleClosedAt, scope.intentPersistedAt].every(timestamp) ||
    scope.campaignEndAt - scope.campaignStartAt !== 180 * 86_400_000 ||
    scope.campaignStartAt % 86_400_000 !== 0 || scope.candleClosedAt % 86_400_000 !== 0 || scope.candleClosedAt < scope.campaignStartAt ||
    scope.candleClosedAt >= scope.campaignEndAt || scope.intentPersistedAt < scope.candleClosedAt) return reject("INVALID_SCOPE");
  if (scope.clockVerified !== true) return reject("CLOCK_UNVERIFIED");
  if (!record(book) || book.productId !== scope.productId || book.sourceProfileId !== scope.sourceProfileId) return reject("IDENTITY_MISMATCH");
  if (book.cacheStatus !== "UNCACHED") return reject("CACHE_UNVERIFIED");
  const { requestedAt, receivedAt, sourceObservedAt } = book;
  if (!timestamp(requestedAt) || !timestamp(receivedAt) || requestedAt < scope.intentPersistedAt || receivedAt < requestedAt ||
    receivedAt - requestedAt > 5_000 || receivedAt >= scope.campaignEndAt || receivedAt - scope.candleClosedAt > 7_200_000) return reject("INVALID_TIMELINE");
  if (sourceObservedAt === null || sourceObservedAt === undefined) return reject("SOURCE_TIME_UNAVAILABLE");
  if (!timestamp(sourceObservedAt) || sourceObservedAt > receivedAt || receivedAt - sourceObservedAt > 5_000) return reject("SOURCE_TIME_INVALID");
  if (!decimalSequence(book.sequence) || (scope.previousSequence !== null &&
    (!decimalSequence(scope.previousSequence) || BigInt(book.sequence) < BigInt(scope.previousSequence)))) return reject("SEQUENCE_INVALID");
  if (!validSide(book.bids, "bid") || !validSide(book.asks, "ask") ||
    (book.bids[0]?.price ?? Infinity) > (book.asks[0]?.price ?? 0)) return reject("BOOK_INVALID");
  return { eligible: true, reason: "ELIGIBLE_BOOK" };
};
