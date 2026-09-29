import type { PaperValuationResult } from "./paper-valuation.js";

const DAY_MS = 86_400_000;

export interface DailyRiskWindow {
  readonly utcDayStart: number;
  readonly openingEquity: number;
}

export interface DailyRiskAssessment {
  readonly window: DailyRiskWindow;
  readonly dailyPnl: number;
}

/**
 * Existing risk-window contract: the caller supplies its current risk mark.
 * This function does not select a price source or freshness policy. Replacing
 * that input with paper telemetry valuation changes risk behavior and needs a
 * separately reviewed model; DAO #62 leaves it unchanged.
 */
export const resolveDailyRiskWindow = (
  current: DailyRiskWindow | null,
  now: number,
  markedEquity: number,
): DailyRiskAssessment => {
  const utcDayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const window =
    current === null || current.utcDayStart !== utcDayStart
      ? Object.freeze({ utcDayStart, openingEquity: markedEquity })
      : current;
  return Object.freeze({
    window,
    dailyPnl: markedEquity - window.openingEquity,
  });
};

export interface PaperDailyRiskState {
  readonly window: DailyRiskWindow | null;
  readonly dailyPnl: number;
}

/**
 * Paper daily-risk source (models/daily-risk.md §3, 2026-09-28 amendment).
 *
 * The marked equity comes from `projectPaperValuation` on the last accepted,
 * dated mark. A numeric equity (fresh or stale mark, or flat portfolio)
 * resolves the UTC window through `resolveDailyRiskWindow`. An unavailable
 * equity (open position without any mark) carries the current window and
 * dailyPnl unchanged: a window never opens on acquisition cost.
 */
export const resolvePaperDailyRisk = (
  current: DailyRiskWindow | null,
  currentDailyPnl: number,
  now: number,
  valuation: PaperValuationResult,
): PaperDailyRiskState => {
  if (!valuation.ok || valuation.value.equity === null) {
    return Object.freeze({ window: current, dailyPnl: currentDailyPnl });
  }
  return resolveDailyRiskWindow(current, now, valuation.value.equity);
};
