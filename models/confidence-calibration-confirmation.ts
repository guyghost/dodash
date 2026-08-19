import type { CalibratedStrategyId } from "./confidence-calibration.js";

export const CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES = Object.freeze([
  "IDENTITY",
  "POWER_THIRD",
] as const);

export type ConfidenceCalibrationConfirmationProfile =
  (typeof CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES)[number];

export interface ConfidenceCalibrationConfirmationObservation {
  readonly profile: ConfidenceCalibrationConfirmationProfile;
  readonly runKey: string;
  readonly strategyId: CalibratedStrategyId;
  readonly evaluationCount: number;
  readonly activeSignalCount: number;
  readonly buySignalCount: number;
  readonly sellSignalCount: number;
  readonly medianRequestedNotional: number | null;
  readonly p95RequestedNotional: number | null;
  readonly capRate: number;
  readonly riskRejectionRate: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
}

export interface ConfidenceCalibrationConfirmationRunInvariant {
  readonly runKey: string;
  readonly benchmarkUnchanged: boolean;
  readonly referenceScenarioUnchanged: boolean;
}

export type ConfidenceCalibrationConfirmationFailureReason =
  | "INACTIVE_RUN"
  | "EXPOSURE_OUT_OF_RANGE"
  | "RUN_COVERAGE_LIMIT"
  | "ALLOCATION_CAPPED"
  | "RISK_REDUCED"
  | "DRAWDOWN_LIMIT"
  | "TURNOVER_LIMIT"
  | "FEE_LIMIT";

export interface ConfidenceCalibrationConfirmationAssessment {
  readonly profile: "POWER_THIRD";
  readonly verdict: "CONFIRMED" | "NOT_CONFIRMED";
  readonly failureReasons: readonly ConfidenceCalibrationConfirmationFailureReason[];
  readonly medianRequestedNotionalByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
  readonly inBandRunRateByStrategy: Readonly<
    Record<CalibratedStrategyId, number>
  >;
  readonly maxCapRate: number;
  readonly maxRiskRejectionRate: number;
  readonly maxDrawdown: number;
  readonly maxTurnover: number;
  readonly maxFeeRate: number;
}

export type ConfidenceCalibrationConfirmationResult =
  | {
      readonly ok: true;
      readonly value: ConfidenceCalibrationConfirmationAssessment;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE";
      };
    };

const STRATEGY_IDS = Object.freeze([
  "ema-cross",
  "breakout",
] as const satisfies readonly CalibratedStrategyId[]);
const MIN_MEDIAN_REQUESTED_NOTIONAL = 100;
const MAX_MEDIAN_REQUESTED_NOTIONAL = 400;
const MIN_IN_BAND_RUN_RATE = 0.75;
const MAX_DRAWDOWN = 0.1;
const MAX_TURNOVER = 10;
const MAX_FEE_RATE = 0.01;

const isConfirmationProfile = (
  value: unknown,
): value is ConfidenceCalibrationConfirmationProfile =>
  typeof value === "string" &&
  CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES.some(
    (profile) => profile === value,
  );

const isStrategyId = (value: unknown): value is CalibratedStrategyId =>
  typeof value === "string" &&
  STRATEGY_IDS.some((strategyId) => strategyId === value);

const validCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const validRate = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const validDistribution = (
  activeSignalCount: number,
  medianRequestedNotional: number | null,
  p95RequestedNotional: number | null,
): boolean => {
  if (activeSignalCount === 0) {
    return medianRequestedNotional === null && p95RequestedNotional === null;
  }
  return (
    medianRequestedNotional !== null &&
    p95RequestedNotional !== null &&
    Number.isFinite(medianRequestedNotional) &&
    Number.isFinite(p95RequestedNotional) &&
    medianRequestedNotional > 0 &&
    p95RequestedNotional >= medianRequestedNotional
  );
};

const validObservation = (
  observation: ConfidenceCalibrationConfirmationObservation,
  expectedRunKeys: ReadonlySet<string>,
): boolean =>
  isConfirmationProfile(observation.profile) &&
  expectedRunKeys.has(observation.runKey) &&
  isStrategyId(observation.strategyId) &&
  validCount(observation.evaluationCount) &&
  validCount(observation.activeSignalCount) &&
  observation.activeSignalCount <= observation.evaluationCount &&
  validCount(observation.buySignalCount) &&
  validCount(observation.sellSignalCount) &&
  observation.buySignalCount + observation.sellSignalCount ===
    observation.activeSignalCount &&
  validDistribution(
    observation.activeSignalCount,
    observation.medianRequestedNotional,
    observation.p95RequestedNotional,
  ) &&
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

const invalidEvidence = (): ConfidenceCalibrationConfirmationResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE" as const,
    }),
  });

const sameSignalPopulation = (
  baseline: ConfidenceCalibrationConfirmationObservation,
  calibrated: ConfidenceCalibrationConfirmationObservation,
): boolean =>
  baseline.evaluationCount === calibrated.evaluationCount &&
  baseline.activeSignalCount === calibrated.activeSignalCount &&
  baseline.buySignalCount === calibrated.buySignalCount &&
  baseline.sellSignalCount === calibrated.sellSignalCount;

export const assessConfidenceCalibrationConfirmation = (
  expectedRunKeys: readonly string[],
  observations: readonly ConfidenceCalibrationConfirmationObservation[],
  runInvariants: readonly ConfidenceCalibrationConfirmationRunInvariant[],
): ConfidenceCalibrationConfirmationResult => {
  const uniqueRunKeys = new Set(expectedRunKeys);
  if (
    expectedRunKeys.length === 0 ||
    uniqueRunKeys.size !== expectedRunKeys.length ||
    expectedRunKeys.some((runKey) => runKey.trim().length === 0) ||
    observations.length !==
      expectedRunKeys.length *
        CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES.length *
        STRATEGY_IDS.length ||
    !observations.every((observation) =>
      validObservation(observation, uniqueRunKeys),
    ) ||
    runInvariants.length !== expectedRunKeys.length
  ) {
    return invalidEvidence();
  }

  const evidenceByKey = new Map<
    string,
    ConfidenceCalibrationConfirmationObservation
  >();
  for (const observation of observations) {
    const key = `${observation.profile}:${observation.runKey}:${observation.strategyId}`;
    if (evidenceByKey.has(key)) return invalidEvidence();
    evidenceByKey.set(key, observation);
  }

  const invariantRunKeys = new Set<string>();
  for (const invariant of runInvariants) {
    if (
      !uniqueRunKeys.has(invariant.runKey) ||
      invariantRunKeys.has(invariant.runKey) ||
      invariant.benchmarkUnchanged !== true ||
      invariant.referenceScenarioUnchanged !== true
    ) {
      return invalidEvidence();
    }
    invariantRunKeys.add(invariant.runKey);
  }

  for (const runKey of expectedRunKeys) {
    for (const strategyId of STRATEGY_IDS) {
      const baseline = evidenceByKey.get(`IDENTITY:${runKey}:${strategyId}`);
      const calibrated = evidenceByKey.get(
        `POWER_THIRD:${runKey}:${strategyId}`,
      );
      if (
        baseline === undefined ||
        calibrated === undefined ||
        !sameSignalPopulation(baseline, calibrated)
      ) {
        return invalidEvidence();
      }
    }
  }

  const calibratedObservations = observations.filter(
    (observation) => observation.profile === "POWER_THIRD",
  );
  const medianRequestedNotionalByStrategy = Object.freeze(
    Object.fromEntries(
      STRATEGY_IDS.map((strategyId) => [
        strategyId,
        median(
          calibratedObservations
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
  const inBandRunRateByStrategy = Object.freeze(
    Object.fromEntries(
      STRATEGY_IDS.map((strategyId) => {
        const inBandCount = calibratedObservations.filter(
          (observation) =>
            observation.strategyId === strategyId &&
            observation.medianRequestedNotional !== null &&
            observation.medianRequestedNotional >=
              MIN_MEDIAN_REQUESTED_NOTIONAL &&
            observation.medianRequestedNotional <=
              MAX_MEDIAN_REQUESTED_NOTIONAL,
        ).length;
        return [strategyId, inBandCount / expectedRunKeys.length];
      }),
    ) as Record<CalibratedStrategyId, number>,
  );
  const maxCapRate = Math.max(
    ...calibratedObservations.map(({ capRate }) => capRate),
  );
  const maxRiskRejectionRate = Math.max(
    ...calibratedObservations.map(
      ({ riskRejectionRate }) => riskRejectionRate,
    ),
  );
  const maxDrawdown = Math.max(
    ...calibratedObservations.map(({ maxDrawdown: value }) => value),
  );
  const maxTurnover = Math.max(
    ...calibratedObservations.map(({ turnover }) => turnover),
  );
  const maxFeeRate = Math.max(
    ...calibratedObservations.map(({ feeRate }) => feeRate),
  );

  const failureReasons: ConfidenceCalibrationConfirmationFailureReason[] = [];
  if (
    calibratedObservations.some(
      ({ activeSignalCount }) => activeSignalCount === 0,
    )
  ) {
    failureReasons.push("INACTIVE_RUN");
  }
  if (
    STRATEGY_IDS.some((strategyId) => {
      const value = medianRequestedNotionalByStrategy[strategyId];
      return (
        value === null ||
        value < MIN_MEDIAN_REQUESTED_NOTIONAL ||
        value > MAX_MEDIAN_REQUESTED_NOTIONAL
      );
    })
  ) {
    failureReasons.push("EXPOSURE_OUT_OF_RANGE");
  }
  if (
    STRATEGY_IDS.some(
      (strategyId) =>
        inBandRunRateByStrategy[strategyId] < MIN_IN_BAND_RUN_RATE,
    )
  ) {
    failureReasons.push("RUN_COVERAGE_LIMIT");
  }
  if (maxCapRate > 0) failureReasons.push("ALLOCATION_CAPPED");
  if (maxRiskRejectionRate > 0) failureReasons.push("RISK_REDUCED");
  if (maxDrawdown > MAX_DRAWDOWN) failureReasons.push("DRAWDOWN_LIMIT");
  if (maxTurnover > MAX_TURNOVER) failureReasons.push("TURNOVER_LIMIT");
  if (maxFeeRate > MAX_FEE_RATE) failureReasons.push("FEE_LIMIT");

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      profile: "POWER_THIRD" as const,
      verdict:
        failureReasons.length === 0
          ? ("CONFIRMED" as const)
          : ("NOT_CONFIRMED" as const),
      failureReasons: Object.freeze(failureReasons),
      medianRequestedNotionalByStrategy,
      inBandRunRateByStrategy,
      maxCapRate,
      maxRiskRejectionRate,
      maxDrawdown,
      maxTurnover,
      maxFeeRate,
    }),
  });
};
