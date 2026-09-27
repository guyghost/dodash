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
