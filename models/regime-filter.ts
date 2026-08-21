import type {
  RegimeFilterError,
  RegimeFilterPolicy,
  RegimePermissionsResult,
  RegimeKind,
  RegimeObservation,
  RegimePermissions,
} from "./regime-filter.types.js";

export const DEFAULT_REGIME_PERMISSIONS: RegimePermissions = Object.freeze({
  BULLISH: Object.freeze(["ema-cross", "breakout"]),
  BEARISH: Object.freeze(["rsi-reversion"]),
  RANGE: Object.freeze(["rsi-reversion"]),
});

export const isValidRegimeFilterPolicy = (
  policy: RegimeFilterPolicy,
): boolean =>
  Number.isFinite(policy.thresholdBps) &&
  policy.thresholdBps > 0 &&
  policy.thresholdBps < 10_000 &&
  Number.isInteger(policy.minObservations) &&
  policy.minObservations >= 1 &&
  Number.isInteger(policy.confirmationCount) &&
  policy.confirmationCount >= 1;

export const isValidRegimeObservation = (
  observation: RegimeObservation,
  lastObservationStart: number | null,
): boolean =>
  Number.isSafeInteger(observation.start) &&
  observation.start > 0 &&
  (lastObservationStart === null || observation.start > lastObservationStart) &&
  Number.isFinite(observation.emaFast) &&
  observation.emaFast > 0 &&
  Number.isFinite(observation.emaSlow) &&
  observation.emaSlow > 0;

export const classifyRegimeObservation = (
  policy: RegimeFilterPolicy,
  observation: RegimeObservation,
): RegimeKind => {
  const threshold = 1 + policy.thresholdBps / 10_000;
  if (observation.emaFast > observation.emaSlow * threshold) return "BULLISH";
  if (observation.emaFast < observation.emaSlow * (2 - threshold)) {
    return "BEARISH";
  }
  return "RANGE";
};

export const resolveRegimePermission = (
  regime: RegimeKind,
  strategyId: string,
  permissions: RegimePermissions = DEFAULT_REGIME_PERMISSIONS,
): RegimePermissionsResult<boolean> => {
  const allowed = permissions[regime];
  if (allowed === undefined) {
    return {
      ok: false,
      error: { code: "INVALID_REGIME_POLICY" } satisfies RegimeFilterError,
    };
  }
  return { ok: true, value: allowed.includes(strategyId) };
};
