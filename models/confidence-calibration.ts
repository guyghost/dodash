export const CONFIDENCE_CALIBRATION_PROFILES = Object.freeze([
  "IDENTITY",
  "POWER_HALF",
  "POWER_THIRD",
  "POWER_QUARTER",
] as const);

export type ConfidenceCalibrationProfile =
  (typeof CONFIDENCE_CALIBRATION_PROFILES)[number];

export type ConfidenceCalibrationErrorCode =
  | "INVALID_CONFIDENCE_CALIBRATION_PROFILE"
  | "INVALID_RAW_CONFIDENCE";

export type ConfidenceCalibrationResult =
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly error: { readonly code: ConfidenceCalibrationErrorCode };
    };

export type CalibratedStrategyId = "ema-cross" | "breakout";

export interface ConfidenceCalibrationDevelopmentObservation {
  readonly profile: ConfidenceCalibrationProfile;
  readonly runKey: string;
  readonly strategyId: CalibratedStrategyId;
  readonly activeSignalCount: number;
  readonly medianRequestedNotional: number | null;
  readonly capRate: number;
  readonly riskRejectionRate: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
}

export type ConfidenceCalibrationIneligibilityReason =
  | "INACTIVE_RUN"
  | "EXPOSURE_OUT_OF_RANGE"
  | "ALLOCATION_CAPPED"
  | "RISK_REDUCED"
  | "DRAWDOWN_LIMIT"
  | "TURNOVER_LIMIT"
  | "FEE_LIMIT";

export interface ConfidenceCalibrationCandidateSummary {
  readonly profile: ConfidenceCalibrationProfile;
  readonly eligible: boolean;
  readonly ineligibilityReasons: readonly ConfidenceCalibrationIneligibilityReason[];
  readonly medianRequestedNotionalByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
  readonly maxCapRate: number;
  readonly maxRiskRejectionRate: number;
  readonly maxDrawdown: number;
  readonly maxTurnover: number;
  readonly maxFeeRate: number;
}

export interface ConfidenceCalibrationSelection {
  readonly selectedProfile: ConfidenceCalibrationProfile | null;
  readonly candidates: readonly ConfidenceCalibrationCandidateSummary[];
}

export type ConfidenceCalibrationSelectionResult =
  | { readonly ok: true; readonly value: ConfidenceCalibrationSelection }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_CONFIDENCE_CALIBRATION_EVIDENCE";
      };
    };

const CALIBRATED_STRATEGY_IDS = Object.freeze([
  "ema-cross",
  "breakout",
] as const);
const PROFILE_EXPONENTS: Readonly<Record<ConfidenceCalibrationProfile, number>> =
  Object.freeze({
    IDENTITY: 1,
    POWER_HALF: 1 / 2,
    POWER_THIRD: 1 / 3,
    POWER_QUARTER: 1 / 4,
  });
const MIN_MEDIAN_REQUESTED_NOTIONAL = 100;
const MAX_MEDIAN_REQUESTED_NOTIONAL = 400;
const MAX_DRAWDOWN = 0.1;
const MAX_TURNOVER = 10;
const MAX_FEE_RATE = 0.01;

export const isConfidenceCalibrationProfile = (
  value: unknown,
): value is ConfidenceCalibrationProfile =>
  typeof value === "string" &&
  CONFIDENCE_CALIBRATION_PROFILES.some((profile) => profile === value);

export const calibrateConfidence = (
  profile: unknown,
  rawConfidence: number,
): ConfidenceCalibrationResult => {
  if (!isConfidenceCalibrationProfile(profile)) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "INVALID_CONFIDENCE_CALIBRATION_PROFILE" as const,
      }),
    });
  }
  if (
    !Number.isFinite(rawConfidence) ||
    rawConfidence < 0 ||
    rawConfidence > 1
  ) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "INVALID_RAW_CONFIDENCE" as const }),
    });
  }
  if (rawConfidence === 0 || rawConfidence === 1) {
    return Object.freeze({ ok: true as const, value: rawConfidence });
  }
  return Object.freeze({
    ok: true as const,
    value: rawConfidence ** PROFILE_EXPONENTS[profile],
  });
};

const validRate = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const validObservation = (
  observation: ConfidenceCalibrationDevelopmentObservation,
  expectedRunKeys: ReadonlySet<string>,
): boolean =>
  isConfidenceCalibrationProfile(observation.profile) &&
  expectedRunKeys.has(observation.runKey) &&
  CALIBRATED_STRATEGY_IDS.some(
    (strategyId) => strategyId === observation.strategyId,
  ) &&
  Number.isSafeInteger(observation.activeSignalCount) &&
  observation.activeSignalCount >= 0 &&
  (observation.activeSignalCount === 0
    ? observation.medianRequestedNotional === null
    : observation.medianRequestedNotional !== null &&
      Number.isFinite(observation.medianRequestedNotional) &&
      observation.medianRequestedNotional > 0) &&
  validRate(observation.capRate) &&
  validRate(observation.riskRejectionRate) &&
  validRate(observation.maxDrawdown) &&
  Number.isFinite(observation.turnover) &&
  observation.turnover >= 0 &&
  Number.isFinite(observation.feeRate) &&
  observation.feeRate >= 0;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
};

const selectionFailure = (): ConfidenceCalibrationSelectionResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "INVALID_CONFIDENCE_CALIBRATION_EVIDENCE" as const,
    }),
  });

export const selectConfidenceCalibrationProfile = (
  expectedRunKeys: readonly string[],
  observations: readonly ConfidenceCalibrationDevelopmentObservation[],
): ConfidenceCalibrationSelectionResult => {
  const uniqueRunKeys = new Set(expectedRunKeys);
  if (
    expectedRunKeys.length === 0 ||
    uniqueRunKeys.size !== expectedRunKeys.length ||
    expectedRunKeys.some((runKey) => runKey.trim().length === 0) ||
    observations.length !==
      expectedRunKeys.length *
        CONFIDENCE_CALIBRATION_PROFILES.length *
        CALIBRATED_STRATEGY_IDS.length ||
    !observations.every((observation) =>
      validObservation(observation, uniqueRunKeys),
    )
  ) {
    return selectionFailure();
  }

  const evidenceKeys = new Set<string>();
  for (const observation of observations) {
    const key = `${observation.profile}:${observation.runKey}:${observation.strategyId}`;
    if (evidenceKeys.has(key)) return selectionFailure();
    evidenceKeys.add(key);
  }

  const candidates = CONFIDENCE_CALIBRATION_PROFILES.map((profile) => {
    const profileObservations = observations.filter(
      (observation) => observation.profile === profile,
    );
    const medianRequestedNotionalByStrategy = Object.freeze(
      Object.fromEntries(
        CALIBRATED_STRATEGY_IDS.map((strategyId) => [
          strategyId,
          median(
            profileObservations
              .filter((observation) => observation.strategyId === strategyId)
              .flatMap((observation) =>
                observation.medianRequestedNotional === null
                  ? []
                  : [observation.medianRequestedNotional],
              ),
          ),
        ]),
      ) as Record<CalibratedStrategyId, number | null>,
    );
    const maxCapRate = Math.max(
      ...profileObservations.map(({ capRate }) => capRate),
    );
    const maxRiskRejectionRate = Math.max(
      ...profileObservations.map(({ riskRejectionRate }) => riskRejectionRate),
    );
    const maxDrawdown = Math.max(
      ...profileObservations.map((observation) => observation.maxDrawdown),
    );
    const maxTurnover = Math.max(
      ...profileObservations.map((observation) => observation.turnover),
    );
    const maxFeeRate = Math.max(
      ...profileObservations.map((observation) => observation.feeRate),
    );
    const reasons: ConfidenceCalibrationIneligibilityReason[] = [];
    if (
      profileObservations.some(
        (observation) =>
          observation.activeSignalCount === 0 ||
          observation.medianRequestedNotional === null,
      )
    ) {
      reasons.push("INACTIVE_RUN");
    }
    if (
      CALIBRATED_STRATEGY_IDS.some((strategyId) => {
        const value = medianRequestedNotionalByStrategy[strategyId];
        return (
          value === null ||
          value < MIN_MEDIAN_REQUESTED_NOTIONAL ||
          value > MAX_MEDIAN_REQUESTED_NOTIONAL
        );
      })
    ) {
      reasons.push("EXPOSURE_OUT_OF_RANGE");
    }
    if (maxCapRate > 0) reasons.push("ALLOCATION_CAPPED");
    if (maxRiskRejectionRate > 0) reasons.push("RISK_REDUCED");
    if (maxDrawdown > MAX_DRAWDOWN) reasons.push("DRAWDOWN_LIMIT");
    if (maxTurnover > MAX_TURNOVER) reasons.push("TURNOVER_LIMIT");
    if (maxFeeRate > MAX_FEE_RATE) reasons.push("FEE_LIMIT");

    return Object.freeze({
      profile,
      eligible: reasons.length === 0,
      ineligibilityReasons: Object.freeze(reasons),
      medianRequestedNotionalByStrategy,
      maxCapRate,
      maxRiskRejectionRate,
      maxDrawdown,
      maxTurnover,
      maxFeeRate,
    });
  });
  const selectedProfile =
    candidates.find(({ eligible }) => eligible)?.profile ?? null;
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      selectedProfile,
      candidates: Object.freeze(candidates),
    }),
  });
};
