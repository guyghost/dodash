import type { CalibratedStrategyId } from "./confidence-calibration.js";
import {
  assessConfidenceCalibrationConfirmation,
  type ConfidenceCalibrationConfirmationAssessment,
  type ConfidenceCalibrationConfirmationObservation,
  type ConfidenceCalibrationConfirmationProfile,
  type ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";

export const CONFIDENCE_QUANTILE_ESTIMATORS = Object.freeze([
  "LINEAR_R7",
  "NEAREST_RANK",
  "LOWER",
  "HIGHER",
] as const);

export type ConfidenceQuantileEstimator =
  (typeof CONFIDENCE_QUANTILE_ESTIMATORS)[number];

export const CONFIDENCE_QUANTILE_SENSITIVITY_POLICY = Object.freeze({
  probability: 0.95,
  medianEstimator: "LINEAR_R7" as const,
  selectedEstimator: "NEAREST_RANK" as const,
  maxP95RequestedNotional: 600,
  maxP95ToMedianRatio: 2,
});

export interface ConfidenceQuantileSensitivityObservation {
  readonly profile: ConfidenceCalibrationConfirmationProfile;
  readonly runKey: string;
  readonly strategyId: CalibratedStrategyId;
  readonly evaluationCount: number;
  readonly activeSignalCount: number;
  readonly buySignalCount: number;
  readonly sellSignalCount: number;
  readonly requestedNotionalSamples: readonly number[];
  readonly capRate: number;
  readonly riskRejectionRate: number;
  readonly maxDrawdown: number;
  readonly turnover: number;
  readonly feeRate: number;
}

export type ConfidenceQuantileSensitivityFailureReason =
  | "BASE_CONFIRMATION_FAILED"
  | "P95_NOTIONAL_LIMIT"
  | "P95_MEDIAN_RATIO_LIMIT";

export interface ConfidenceQuantileEstimatorAssessment {
  readonly estimator: ConfidenceQuantileEstimator;
  readonly verdict: "TAIL_CONFIRMED" | "TAIL_NOT_CONFIRMED";
  readonly failureReasons: readonly ConfidenceQuantileSensitivityFailureReason[];
  readonly absoluteBreachCount: number;
  readonly ratioBreachCount: number;
  readonly maxP95RequestedNotionalByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
  readonly maxP95ToMedianRatioByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
}

export interface ConfidenceQuantileSensitivityAssessment {
  readonly profile: "POWER_THIRD";
  readonly selectedEstimator: "NEAREST_RANK";
  readonly selectedVerdict: "TAIL_CONFIRMED" | "TAIL_NOT_CONFIRMED";
  readonly selectedFailureReasons: readonly ConfidenceQuantileSensitivityFailureReason[];
  readonly sensitivityVerdict: "AGREEMENT" | "DISAGREEMENT";
  readonly baseAssessment: ConfidenceCalibrationConfirmationAssessment;
  readonly estimators: readonly ConfidenceQuantileEstimatorAssessment[];
}

export type QuantileEstimateResult =
  | { readonly ok: true; readonly value: number | null }
  | {
      readonly ok: false;
      readonly error: { readonly code: "INVALID_QUANTILE_INPUT" };
    };

export type ConfidenceQuantileSensitivityResult =
  | {
      readonly ok: true;
      readonly value: ConfidenceQuantileSensitivityAssessment;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_CONFIDENCE_QUANTILE_SENSITIVITY_EVIDENCE";
      };
    };

const STRATEGY_IDS = Object.freeze([
  "ema-cross",
  "breakout",
] as const satisfies readonly CalibratedStrategyId[]);

const isEstimator = (value: unknown): value is ConfidenceQuantileEstimator =>
  typeof value === "string" &&
  CONFIDENCE_QUANTILE_ESTIMATORS.some((estimator) => estimator === value);

export const estimateQuantile = (
  values: readonly number[],
  probability: number,
  estimator: ConfidenceQuantileEstimator,
): QuantileEstimateResult => {
  if (
    !Array.isArray(values) ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1 ||
    !isEstimator(estimator) ||
    !values.every((value) => Number.isFinite(value) && value > 0)
  ) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "INVALID_QUANTILE_INPUT" as const }),
    });
  }
  if (values.length === 0) {
    return Object.freeze({ ok: true as const, value: null });
  }

  const sorted = [...values].sort((left, right) => left - right);
  const r7Position = (sorted.length - 1) * probability;
  let index: number;
  if (estimator === "NEAREST_RANK") {
    index = Math.max(0, Math.ceil(sorted.length * probability) - 1);
  } else if (estimator === "LOWER") {
    index = Math.floor(r7Position);
  } else if (estimator === "HIGHER") {
    index = Math.ceil(r7Position);
  } else {
    const lowerIndex = Math.floor(r7Position);
    const upperIndex = Math.ceil(r7Position);
    const lower = sorted[lowerIndex];
    const upper = sorted[upperIndex];
    if (lower === undefined || upper === undefined) {
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "INVALID_QUANTILE_INPUT" as const }),
      });
    }
    return Object.freeze({
      ok: true as const,
      value: lower + (upper - lower) * (r7Position - lowerIndex),
    });
  }

  const value = sorted[index];
  return value === undefined
    ? Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "INVALID_QUANTILE_INPUT" as const }),
      })
    : Object.freeze({ ok: true as const, value });
};

const invalidEvidence = (): ConfidenceQuantileSensitivityResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "INVALID_CONFIDENCE_QUANTILE_SENSITIVITY_EVIDENCE" as const,
    }),
  });

const validSamples = (
  observation: ConfidenceQuantileSensitivityObservation,
): boolean =>
  Number.isSafeInteger(observation.activeSignalCount) &&
  observation.activeSignalCount >= 0 &&
  Array.isArray(observation.requestedNotionalSamples) &&
  observation.requestedNotionalSamples.length === observation.activeSignalCount &&
  observation.requestedNotionalSamples.every(
    (value) => Number.isFinite(value) && value > 0,
  );

const toConfirmationObservation = (
  observation: ConfidenceQuantileSensitivityObservation,
): ConfidenceCalibrationConfirmationObservation | null => {
  if (!validSamples(observation)) return null;
  const median = estimateQuantile(
    observation.requestedNotionalSamples,
    0.5,
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.medianEstimator,
  );
  const p95 = estimateQuantile(
    observation.requestedNotionalSamples,
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability,
    "LINEAR_R7",
  );
  if (!median.ok || !p95.ok) return null;
  return Object.freeze({
    profile: observation.profile,
    runKey: observation.runKey,
    strategyId: observation.strategyId,
    evaluationCount: observation.evaluationCount,
    activeSignalCount: observation.activeSignalCount,
    buySignalCount: observation.buySignalCount,
    sellSignalCount: observation.sellSignalCount,
    medianRequestedNotional: median.value,
    p95RequestedNotional: p95.value,
    capRate: observation.capRate,
    riskRejectionRate: observation.riskRejectionRate,
    maxDrawdown: observation.maxDrawdown,
    turnover: observation.turnover,
    feeRate: observation.feeRate,
  });
};

const maximum = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.max(...values);

const assessEstimator = (
  estimator: ConfidenceQuantileEstimator,
  observations: readonly ConfidenceQuantileSensitivityObservation[],
  baseAssessment: ConfidenceCalibrationConfirmationAssessment,
): ConfidenceQuantileEstimatorAssessment | null => {
  const active = observations.filter(
    (observation) =>
      observation.profile === "POWER_THIRD" &&
      observation.activeSignalCount > 0,
  );
  const tails = active.map((observation) => {
    const median = estimateQuantile(
      observation.requestedNotionalSamples,
      0.5,
      CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.medianEstimator,
    );
    const p95 = estimateQuantile(
      observation.requestedNotionalSamples,
      CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability,
      estimator,
    );
    if (
      !median.ok ||
      !p95.ok ||
      median.value === null ||
      p95.value === null ||
      median.value <= 0
    ) {
      return null;
    }
    return Object.freeze({
      strategyId: observation.strategyId,
      p95: p95.value,
      ratio: p95.value / median.value,
    });
  });
  if (tails.some((tail) => tail === null)) return null;
  const validTails = tails.filter((tail) => tail !== null);
  const absoluteBreachCount = validTails.filter(
    ({ p95 }) =>
      p95 > CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional,
  ).length;
  const ratioBreachCount = validTails.filter(
    ({ ratio }) =>
      ratio > CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio,
  ).length;
  const failureReasons: ConfidenceQuantileSensitivityFailureReason[] = [];
  if (baseAssessment.verdict !== "CONFIRMED") {
    failureReasons.push("BASE_CONFIRMATION_FAILED");
  }
  if (absoluteBreachCount > 0) failureReasons.push("P95_NOTIONAL_LIMIT");
  if (ratioBreachCount > 0) failureReasons.push("P95_MEDIAN_RATIO_LIMIT");

  return Object.freeze({
    estimator,
    verdict:
      failureReasons.length === 0
        ? ("TAIL_CONFIRMED" as const)
        : ("TAIL_NOT_CONFIRMED" as const),
    failureReasons: Object.freeze(failureReasons),
    absoluteBreachCount,
    ratioBreachCount,
    maxP95RequestedNotionalByStrategy: Object.freeze(
      Object.fromEntries(
        STRATEGY_IDS.map((strategyId) => [
          strategyId,
          maximum(
            validTails
              .filter((tail) => tail.strategyId === strategyId)
              .map(({ p95 }) => p95),
          ),
        ]),
      ) as Record<CalibratedStrategyId, number | null>,
    ),
    maxP95ToMedianRatioByStrategy: Object.freeze(
      Object.fromEntries(
        STRATEGY_IDS.map((strategyId) => [
          strategyId,
          maximum(
            validTails
              .filter((tail) => tail.strategyId === strategyId)
              .map(({ ratio }) => ratio),
          ),
        ]),
      ) as Record<CalibratedStrategyId, number | null>,
    ),
  });
};

export const assessConfidenceQuantileSensitivity = (
  expectedRunKeys: readonly string[],
  observations: readonly ConfidenceQuantileSensitivityObservation[],
  runInvariants: readonly ConfidenceCalibrationConfirmationRunInvariant[],
): ConfidenceQuantileSensitivityResult => {
  const confirmationObservations = observations.map(toConfirmationObservation);
  if (confirmationObservations.some((observation) => observation === null)) {
    return invalidEvidence();
  }
  const base = assessConfidenceCalibrationConfirmation(
    expectedRunKeys,
    confirmationObservations.filter((observation) => observation !== null),
    runInvariants,
  );
  if (!base.ok) return invalidEvidence();

  const estimators = CONFIDENCE_QUANTILE_ESTIMATORS.map((estimator) =>
    assessEstimator(estimator, observations, base.value),
  );
  if (estimators.some((assessment) => assessment === null)) {
    return invalidEvidence();
  }
  const validEstimators = estimators.filter((assessment) => assessment !== null);
  const selected = validEstimators.find(
    ({ estimator }) =>
      estimator === CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator,
  );
  if (selected === undefined) return invalidEvidence();
  const verdicts = new Set(validEstimators.map(({ verdict }) => verdict));

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      profile: "POWER_THIRD" as const,
      selectedEstimator:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator,
      selectedVerdict: selected.verdict,
      selectedFailureReasons: selected.failureReasons,
      sensitivityVerdict:
        verdicts.size === 1
          ? ("AGREEMENT" as const)
          : ("DISAGREEMENT" as const),
      baseAssessment: base.value,
      estimators: Object.freeze(validEstimators),
    }),
  });
};
