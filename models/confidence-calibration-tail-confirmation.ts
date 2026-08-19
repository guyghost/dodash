import type { CalibratedStrategyId } from "./confidence-calibration.js";
import {
  assessConfidenceCalibrationConfirmation,
  type ConfidenceCalibrationConfirmationAssessment,
  type ConfidenceCalibrationConfirmationObservation,
  type ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";

export const CONFIDENCE_CALIBRATION_TAIL_POLICY = Object.freeze({
  maxP95RequestedNotional: 600,
  maxP95ToMedianRatio: 2,
});

export type ConfidenceCalibrationTailConfirmationFailureReason =
  | "BASE_CONFIRMATION_FAILED"
  | "P95_NOTIONAL_LIMIT"
  | "P95_MEDIAN_RATIO_LIMIT";

export interface ConfidenceCalibrationTailConfirmationAssessment {
  readonly profile: "POWER_THIRD";
  readonly verdict: "TAIL_CONFIRMED" | "TAIL_NOT_CONFIRMED";
  readonly failureReasons: readonly ConfidenceCalibrationTailConfirmationFailureReason[];
  readonly baseAssessment: ConfidenceCalibrationConfirmationAssessment;
  readonly maxP95RequestedNotionalByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
  readonly maxP95ToMedianRatioByStrategy: Readonly<
    Record<CalibratedStrategyId, number | null>
  >;
}

export type ConfidenceCalibrationTailConfirmationResult =
  | {
      readonly ok: true;
      readonly value: ConfidenceCalibrationTailConfirmationAssessment;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_CONFIDENCE_CALIBRATION_TAIL_CONFIRMATION_EVIDENCE";
      };
    };

const STRATEGY_IDS = Object.freeze([
  "ema-cross",
  "breakout",
] as const satisfies readonly CalibratedStrategyId[]);

const invalidEvidence = (): ConfidenceCalibrationTailConfirmationResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "INVALID_CONFIDENCE_CALIBRATION_TAIL_CONFIRMATION_EVIDENCE" as const,
    }),
  });

const maximum = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.max(...values);

export const assessConfidenceCalibrationTailConfirmation = (
  expectedRunKeys: readonly string[],
  observations: readonly ConfidenceCalibrationConfirmationObservation[],
  runInvariants: readonly ConfidenceCalibrationConfirmationRunInvariant[],
): ConfidenceCalibrationTailConfirmationResult => {
  const baseResult = assessConfidenceCalibrationConfirmation(
    expectedRunKeys,
    observations,
    runInvariants,
  );
  if (!baseResult.ok) return invalidEvidence();

  const calibratedActiveObservations = observations.filter(
    (observation) =>
      observation.profile === "POWER_THIRD" &&
      observation.activeSignalCount > 0 &&
      observation.medianRequestedNotional !== null &&
      observation.p95RequestedNotional !== null,
  );
  const maxP95RequestedNotionalByStrategy = Object.freeze(
    Object.fromEntries(
      STRATEGY_IDS.map((strategyId) => [
        strategyId,
        maximum(
          calibratedActiveObservations
            .filter((observation) => observation.strategyId === strategyId)
            .map((observation) => observation.p95RequestedNotional!),
        ),
      ]),
    ) as Record<CalibratedStrategyId, number | null>,
  );
  const maxP95ToMedianRatioByStrategy = Object.freeze(
    Object.fromEntries(
      STRATEGY_IDS.map((strategyId) => [
        strategyId,
        maximum(
          calibratedActiveObservations
            .filter((observation) => observation.strategyId === strategyId)
            .map(
              (observation) =>
                observation.p95RequestedNotional! /
                observation.medianRequestedNotional!,
            ),
        ),
      ]),
    ) as Record<CalibratedStrategyId, number | null>,
  );

  const failureReasons: ConfidenceCalibrationTailConfirmationFailureReason[] =
    [];
  if (baseResult.value.verdict !== "CONFIRMED") {
    failureReasons.push("BASE_CONFIRMATION_FAILED");
  }
  if (
    calibratedActiveObservations.some(
      (observation) =>
        observation.p95RequestedNotional! >
        CONFIDENCE_CALIBRATION_TAIL_POLICY.maxP95RequestedNotional,
    )
  ) {
    failureReasons.push("P95_NOTIONAL_LIMIT");
  }
  if (
    calibratedActiveObservations.some(
      (observation) =>
        observation.p95RequestedNotional! /
          observation.medianRequestedNotional! >
        CONFIDENCE_CALIBRATION_TAIL_POLICY.maxP95ToMedianRatio,
    )
  ) {
    failureReasons.push("P95_MEDIAN_RATIO_LIMIT");
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      profile: "POWER_THIRD" as const,
      verdict:
        failureReasons.length === 0
          ? ("TAIL_CONFIRMED" as const)
          : ("TAIL_NOT_CONFIRMED" as const),
      failureReasons: Object.freeze(failureReasons),
      baseAssessment: baseResult.value,
      maxP95RequestedNotionalByStrategy,
      maxP95ToMedianRatioByStrategy,
    }),
  });
};
