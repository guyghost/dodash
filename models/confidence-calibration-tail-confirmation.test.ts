import { describe, expect, it } from "vitest";

import type {
  ConfidenceCalibrationConfirmationObservation,
  ConfidenceCalibrationConfirmationProfile,
  ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";
import { assessConfidenceCalibrationTailConfirmation } from "./confidence-calibration-tail-confirmation.js";

const RUN_KEYS = Object.freeze(["XTZ:1", "ZEC:1", "XTZ:2", "ZEC:2"]);
const PROFILES = Object.freeze([
  "IDENTITY",
  "POWER_THIRD",
] as const satisfies readonly ConfidenceCalibrationConfirmationProfile[]);
const STRATEGIES = Object.freeze(["ema-cross", "breakout"] as const);

const calibratedDistribution = (
  strategyId: (typeof STRATEGIES)[number],
  runIndex: number,
): readonly [number, number] => {
  if (strategyId === "ema-cross") {
    return (
      [
        [100, 180],
        [120, 200],
        [130, 220],
        [140, 240],
      ] as const
    )[runIndex] ?? [100, 180];
  }
  return (
    [
      [200, 400],
      [250, 450],
      [300, 500],
      [300, 600],
    ] as const
  )[runIndex] ?? [200, 400];
};

const completeEvidence = (): ConfidenceCalibrationConfirmationObservation[] =>
  PROFILES.flatMap((profile) =>
    RUN_KEYS.flatMap((runKey, runIndex) =>
      STRATEGIES.map((strategyId) => {
        const [calibratedMedian, calibratedP95] = calibratedDistribution(
          strategyId,
          runIndex,
        );
        const medianRequestedNotional =
          profile === "POWER_THIRD"
            ? calibratedMedian
            : strategyId === "ema-cross"
              ? 2
              : 20;
        return {
          profile,
          runKey,
          strategyId,
          evaluationCount: 300,
          activeSignalCount: 10,
          buySignalCount: 4,
          sellSignalCount: 6,
          medianRequestedNotional,
          p95RequestedNotional:
            profile === "POWER_THIRD"
              ? calibratedP95
              : medianRequestedNotional * 1.5,
          capRate: 0,
          riskRejectionRate: 0,
          maxDrawdown: 0.02,
          turnover: 2,
          feeRate: 0.001,
        };
      }),
    ),
  );

const completeRunInvariants =
  (): ConfidenceCalibrationConfirmationRunInvariant[] =>
    RUN_KEYS.map((runKey) => ({
      runKey,
      benchmarkUnchanged: true,
      referenceScenarioUnchanged: true,
    }));

const replaceCalibratedObservation = (
  overrides: Partial<ConfidenceCalibrationConfirmationObservation>,
  strategyId: (typeof STRATEGIES)[number] = "breakout",
): ConfidenceCalibrationConfirmationObservation[] =>
  completeEvidence().map((item) =>
    item.profile === "POWER_THIRD" &&
    item.runKey === RUN_KEYS[3] &&
    item.strategyId === strategyId
      ? { ...item, ...overrides }
      : item,
  );

describe("confidence calibration tail confirmation", () => {
  it("confirme une preuve dont l'échelle, le p95 et le ratio restent bornés", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      completeEvidence(),
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("TAIL_CONFIRMED");
    expect(result.value.failureReasons).toEqual([]);
    expect(result.value.baseAssessment.verdict).toBe("CONFIRMED");
    expect(result.value.maxP95RequestedNotionalByStrategy).toEqual({
      "ema-cross": 240,
      breakout: 600,
    });
    expect(result.value.maxP95ToMedianRatioByStrategy).toEqual({
      "ema-cross": 1.8,
      breakout: 2,
    });
  });

  it("conserve un échec du modèle médian comme motif fermé", () => {
    const evidence = completeEvidence().map((item) => {
      if (
        item.profile !== "POWER_THIRD" ||
        item.strategyId !== "ema-cross" ||
        ![RUN_KEYS[0], RUN_KEYS[1]].includes(item.runKey)
      ) {
        return item;
      }
      return {
        ...item,
        medianRequestedNotional: 50,
        p95RequestedNotional: 75,
      };
    });
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok && result.value.verdict).toBe("TAIL_NOT_CONFIRMED");
    expect(result.ok && result.value.failureReasons).toEqual([
      "BASE_CONFIRMATION_FAILED",
    ]);
    expect(result.ok && result.value.baseAssessment.failureReasons).toContain(
      "RUN_COVERAGE_LIMIT",
    );
  });

  it("refuse un p95 supérieur au plafond absolu", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      replaceCalibratedObservation({
        medianRequestedNotional: 350,
        p95RequestedNotional: 600.01,
      }),
      completeRunInvariants(),
    );

    expect(result.ok && result.value.verdict).toBe("TAIL_NOT_CONFIRMED");
    expect(result.ok && result.value.failureReasons).toEqual([
      "P95_NOTIONAL_LIMIT",
    ]);
  });

  it("refuse un ratio p95 sur médiane supérieur à deux", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      replaceCalibratedObservation(
        { medianRequestedNotional: 100, p95RequestedNotional: 201 },
        "ema-cross",
      ),
      completeRunInvariants(),
    );

    expect(result.ok && result.value.verdict).toBe("TAIL_NOT_CONFIRMED");
    expect(result.ok && result.value.failureReasons).toEqual([
      "P95_MEDIAN_RATIO_LIMIT",
    ]);
  });

  it("conserve simultanément les deux dépassements de queue", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      replaceCalibratedObservation({
        medianRequestedNotional: 300,
        p95RequestedNotional: 700,
      }),
      completeRunInvariants(),
    );

    expect(result.ok && result.value.failureReasons).toEqual([
      "P95_NOTIONAL_LIMIT",
      "P95_MEDIAN_RATIO_LIMIT",
    ]);
  });

  it("accepte exactement les bornes 600 USD et ratio deux", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      replaceCalibratedObservation({
        medianRequestedNotional: 300,
        p95RequestedNotional: 600,
      }),
      completeRunInvariants(),
    );

    expect(result.ok && result.value.verdict).toBe("TAIL_CONFIRMED");
  });

  it("propage une matrice invalide sans produire de verdict", () => {
    const result = assessConfidenceCalibrationTailConfirmation(
      RUN_KEYS,
      completeEvidence().slice(1),
      completeRunInvariants(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "INVALID_CONFIDENCE_CALIBRATION_TAIL_CONFIRMATION_EVIDENCE",
      },
    });
  });
});
