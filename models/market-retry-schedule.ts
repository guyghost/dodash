/**
 * Market retry planner (models/market-retry-schedule.md).
 *
 * Pure and clock-free: the caller injects `now`. It decides *when* the next
 * market fetch may run and whether any retry can still complete before the
 * decision window closes. It never selects a machine transition; the
 * `tradingCycleMachine` guards remain the only judges of freshness and
 * duplicate candles.
 */
export const MARKET_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  60_000, 300_000, 900_000,
]);
export const MARKET_RETRY_MAX_DELAY_MS = 900_000;
/** Bound on early-wake re-arms of one retry alarm (§3, amendment 2026-10-07). */
export const MARKET_RETRY_MAX_REARMS = 3;

/**
 * Rounds up to the whole second: the DO one-shot alarm stores whole seconds
 * and fires as soon as `floor(now / 1000) >= floor(at / 1000)`, so an
 * unaligned deadline could wake up to 999 ms early (§2, amendment 2026-10-07).
 */
export const alignRetryInstant = (instant: number): number =>
  Math.ceil(instant / 1_000) * 1_000;

export interface MarketRetryPlanInput {
  /** 0-based retry index (`context.attempts.marketData - 1`). */
  readonly attempt: number;
  /** Retry budget (`context.retryLimits.marketData`). */
  readonly retryLimit: number;
  readonly retryable: boolean;
  /** `WorkflowError.retryAfterMs`, when the upstream provided one. */
  readonly retryAfterMs: number | null;
  readonly now: number;
  readonly triggeredAt: number;
  readonly timeframeMs: number;
  readonly maxMarketStalenessMs: number;
}

export type MarketRetryExhaustionReason = "NOT_RETRYABLE" | "BUDGET" | "DEADLINE";

export type MarketRetryPlan =
  | {
      readonly kind: "schedule";
      readonly attempt: number;
      readonly nextRetryAt: number;
      readonly deadlineAt: number;
    }
  | {
      readonly kind: "exhausted";
      readonly reason: MarketRetryExhaustionReason;
      readonly deadlineAt: number;
    };

/** `decisionCandleClosedAt + maxMarketStalenessMs` for the cycle's expected candle. */
export const resolveMarketRetryDeadline = (
  triggeredAt: number,
  timeframeMs: number,
  maxMarketStalenessMs: number,
): number =>
  Math.floor(triggeredAt / timeframeMs) * timeframeMs + maxMarketStalenessMs;

const delayForAttempt = (attempt: number, retryAfterMs: number | null): number => {
  const table =
    MARKET_RETRY_DELAYS_MS[Math.min(attempt, MARKET_RETRY_DELAYS_MS.length - 1)] ??
    MARKET_RETRY_MAX_DELAY_MS;
  const requested =
    retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > table
      ? retryAfterMs
      : table;
  return Math.min(requested, MARKET_RETRY_MAX_DELAY_MS);
};

export const planMarketRetry = (input: MarketRetryPlanInput): MarketRetryPlan => {
  const deadlineAt = resolveMarketRetryDeadline(
    input.triggeredAt,
    input.timeframeMs,
    input.maxMarketStalenessMs,
  );
  if (!input.retryable) {
    return Object.freeze({ kind: "exhausted", reason: "NOT_RETRYABLE", deadlineAt });
  }
  if (input.attempt >= input.retryLimit) {
    return Object.freeze({ kind: "exhausted", reason: "BUDGET", deadlineAt });
  }
  const nextRetryAt = alignRetryInstant(
    input.now + delayForAttempt(input.attempt, input.retryAfterMs),
  );
  if (nextRetryAt > deadlineAt) {
    return Object.freeze({ kind: "exhausted", reason: "DEADLINE", deadlineAt });
  }
  return Object.freeze({
    kind: "schedule",
    attempt: input.attempt + 1,
    nextRetryAt,
    deadlineAt,
  });
};

/** `retryTick` alarm payload; `nextRetryAt`/`rearm` are absent on legacy rows. */
export interface MarketRetryWakePayload {
  readonly productId: string | null;
  readonly attempt: number;
  readonly nextRetryAt?: number;
  readonly rearm?: number;
}

export type MarketRetryWake =
  | {
      readonly kind: "rearm";
      readonly at: number;
      readonly payload: MarketRetryWakePayload;
    }
  | { readonly kind: "drop" }
  | { readonly kind: "run"; readonly productId: string | null };

/**
 * Resolves a `retryTick` wake (§3, amendment 2026-10-07) against the deadline
 * persisted in `artifacts.marketRetry` (never the payload): an early wake
 * re-arms the same deadline under a distinct payload (the SDK deduplicates
 * idempotent rows on callback + payload while the firing row still exists);
 * otherwise only the targeted product runs.
 */
export const resolveRetryWake = (input: {
  readonly now: number;
  readonly persistedNextRetryAt: number | null;
  readonly payload: MarketRetryWakePayload | undefined;
}): MarketRetryWake => {
  const productId = input.payload?.productId ?? null;
  const deadline = input.persistedNextRetryAt;
  if (deadline !== null && input.now < deadline) {
    const rearm = input.payload?.rearm ?? 0;
    if (rearm >= MARKET_RETRY_MAX_REARMS) return Object.freeze({ kind: "drop" });
    // Aligned so that a legacy unaligned deadline cannot fire early again.
    const at = alignRetryInstant(deadline);
    return Object.freeze({
      kind: "rearm",
      at,
      payload: Object.freeze({
        productId,
        attempt: input.payload?.attempt ?? 0,
        nextRetryAt: at,
        rearm: rearm + 1,
      }),
    });
  }
  return Object.freeze({ kind: "run", productId });
};
