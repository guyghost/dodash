/**
 * Cycle wake-up schedule and missed-decision projection
 * (models/cycle-schedule.md). Pure functions; no clock, no I/O.
 */
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
export const SCHEDULE_OFFSET_MINUTES = 1;
const OFFSET_THRESHOLD_SECONDS = 600;

export type CycleScheduleResolution =
  | { readonly kind: "cron"; readonly expression: string; readonly intervalSeconds: number }
  | { readonly kind: "interval"; readonly intervalSeconds: number };

/**
 * Aligns an interval on the UTC grid when the interval is a whole number of
 * minutes dividing a day. Intervals of at least ten minutes wake one minute
 * after the boundary so the closed candle is published upstream.
 */
export const resolveCycleSchedule = (intervalSeconds: number): CycleScheduleResolution => {
  const alignable =
    Number.isSafeInteger(intervalSeconds) &&
    intervalSeconds >= 60 &&
    intervalSeconds % 60 === 0 &&
    DAY_SECONDS % intervalSeconds === 0;
  if (!alignable) return Object.freeze({ kind: "interval", intervalSeconds });
  const offset = intervalSeconds >= OFFSET_THRESHOLD_SECONDS ? SCHEDULE_OFFSET_MINUTES : 0;
  const minutes = intervalSeconds / 60;
  let expression: string;
  if (intervalSeconds < HOUR_SECONDS) {
    const minuteExpression = offset === 0
      ? minutes === 1 ? "*" : `*/${minutes}`
      : Array.from({ length: 60 / minutes }, (_, index) => offset + index * minutes).join(",");
    expression = `${minuteExpression} * * * *`;
  } else if (intervalSeconds === HOUR_SECONDS) {
    expression = `${offset} * * * *`;
  } else if (intervalSeconds < DAY_SECONDS) {
    expression = `${offset} */${intervalSeconds / HOUR_SECONDS} * * *`;
  } else {
    expression = `${offset} 0 * * *`;
  }
  return Object.freeze({ kind: "cron", expression, intervalSeconds });
};

export interface MissedDecisionInput {
  readonly triggeredAt: number;
  readonly timeframeMs: number;
  readonly maxMarketStalenessMs: number;
  readonly lastDecisionCandleClosedAt: number | null;
  readonly lastMissedDecisionCandleClosedAt: number | null;
  /**
   * Instant the cycle completed (§3, amendment 2026-10-07). A resumed cycle
   * keeps its original `triggeredAt`; the window is judged when it closes.
   * Required so that no caller silently falls back to `triggeredAt`.
   */
  readonly completedAt: number;
}

export interface MissedDecisionResolution {
  readonly missed: boolean;
  readonly decisionCandleClosedAt: number;
}

/**
 * A decision candle is missed when a cycle completes after the freshness
 * window without a recorded decision for it, and it has not been reported yet.
 */
/**
 * Base delay before product rank k ≥ 1 on a grid wake (§4).
 * 8s clears the previous product's candles, ticker, and the in-request
 * Coinbase backoff (≤ 2.5s) before the next product calls Coinbase.
 */
export const PORTFOLIO_PRODUCT_STAGGER_MS = 8_000;
/** ±25% around the base delay. Rank 0 waits 0. `randomUnit` is injected. */
export const PORTFOLIO_PRODUCT_STAGGER_JITTER_RATIO = 0.25;

/**
 * Wait before the product that already has `executedBefore` siblings run
 * on this grid wake. The first executed product waits 0. Disabled products
 * are not counted by the caller.
 */
export const planPortfolioProductStaggerMs = (
  executedBefore: number,
  randomUnit: number,
): number => {
  if (!Number.isSafeInteger(executedBefore) || executedBefore <= 0) return 0;
  const unit = Number.isFinite(randomUnit)
    ? Math.min(1, Math.max(0, randomUnit))
    : 0;
  const scale =
    1 -
    PORTFOLIO_PRODUCT_STAGGER_JITTER_RATIO +
    2 * PORTFOLIO_PRODUCT_STAGGER_JITTER_RATIO * unit;
  return Math.round(PORTFOLIO_PRODUCT_STAGGER_MS * scale);
};

export const resolveMissedDecision = (input: MissedDecisionInput): MissedDecisionResolution => {
  const decisionCandleClosedAt =
    Math.floor(input.triggeredAt / input.timeframeMs) * input.timeframeMs;
  const evaluatedAt = Math.max(input.triggeredAt, input.completedAt);
  const windowClosed = evaluatedAt - decisionCandleClosedAt > input.maxMarketStalenessMs;
  const decided =
    input.lastDecisionCandleClosedAt !== null &&
    input.lastDecisionCandleClosedAt >= decisionCandleClosedAt;
  const reported =
    input.lastMissedDecisionCandleClosedAt !== null &&
    input.lastMissedDecisionCandleClosedAt >= decisionCandleClosedAt;
  return Object.freeze({
    missed: windowClosed && !decided && !reported,
    decisionCandleClosedAt,
  });
};
