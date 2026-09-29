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
  const nextRetryAt = input.now + delayForAttempt(input.attempt, input.retryAfterMs);
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
