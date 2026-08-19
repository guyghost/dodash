import { describe, expect, it } from "vitest";

import type {
  ConfidenceCalibrationConfirmationProfile,
  ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";
import {
  assessConfidenceQuantileSensitivity,
  estimateQuantile,
  type ConfidenceQuantileSensitivityObservation,
} from "./confidence-quantile-sensitivity.js";

const RUN_KEYS = Object.freeze(["XTZ:1", "ZEC:1", "XTZ:2", "ZEC:2"]);
const PROFILES = Object.freeze([
  "IDENTITY",
  "POWER_THIRD",
] as const satisfies readonly ConfidenceCalibrationConfirmationProfile[]);
const STRATEGIES = Object.freeze(["ema-cross", "breakout"] as const);

const samples = (
  profile: ConfidenceCalibrationConfirmationProfile,
  strategyId: (typeof STRATEGIES)[number],
  runIndex: number,
): readonly number[] => {
  if (profile === "IDENTITY") {
    return Array(10).fill(strategyId === "ema-cross" ? 2 : 20);
  }
  const center =
    strategyId === "ema-cross"
      ? [120, 140, 160, 180][runIndex] ?? 120
      : [220, 240, 260, 280][runIndex] ?? 220;
  return [
    center * 0.75,
    center * 0.8,
    center * 0.85,
    center * 0.9,
    center,
    center,
    center * 1.05,
    center * 1.1,
    center * 1.2,
    center * 1.5,
  ];
};

const completeEvidence = (): ConfidenceQuantileSensitivityObservation[] =>
  PROFILES.flatMap((profile) =>
    RUN_KEYS.flatMap((runKey, runIndex) =>
      STRATEGIES.map((strategyId) => ({
        profile,
        runKey,
        strategyId,
        evaluationCount: 300,
        activeSignalCount: 10,
        buySignalCount: 4,
        sellSignalCount: 6,
        requestedNotionalSamples: samples(profile, strategyId, runIndex),
        capRate: 0,
        riskRejectionRate: 0,
        maxDrawdown: 0.02,
        turnover: 2,
        feeRate: 0.001,
      })),
    ),
  );

const completeRunInvariants =
  (): ConfidenceCalibrationConfirmationRunInvariant[] =>
    RUN_KEYS.map((runKey) => ({
      runKey,
      benchmarkUnchanged: true,
      referenceScenarioUnchanged: true,
    }));

describe("confidence quantile sensitivity", () => {
  it("implémente les quatre conventions p95 pré-enregistrées", () => {
    expect(estimateQuantile([1, 2, 3, 4], 0.95, "LINEAR_R7")).toEqual({
      ok: true,
      value: 3.8499999999999996,
    });
    expect(estimateQuantile([1, 2, 3, 4], 0.95, "NEAREST_RANK")).toEqual({
      ok: true,
      value: 4,
    });
    expect(estimateQuantile([1, 2, 3, 4], 0.95, "LOWER")).toEqual({
      ok: true,
      value: 3,
    });
    expect(estimateQuantile([1, 2, 3, 4], 0.95, "HIGHER")).toEqual({
      ok: true,
      value: 4,
    });
  });

  it("définit les séries vides et les bornes q=0/q=1", () => {
    expect(estimateQuantile([], 0.95, "LINEAR_R7")).toEqual({
      ok: true,
      value: null,
    });
    for (const estimator of [
      "LINEAR_R7",
      "NEAREST_RANK",
      "LOWER",
      "HIGHER",
    ] as const) {
      expect(estimateQuantile([3, 1, 2], 0, estimator)).toEqual({
        ok: true,
        value: 1,
      });
      expect(estimateQuantile([3, 1, 2], 1, estimator)).toEqual({
        ok: true,
        value: 3,
      });
    }
  });

  it("refuse une probabilité, un échantillon ou un estimateur invalide", () => {
    expect(estimateQuantile([1], 1.01, "LINEAR_R7")).toEqual({
      ok: false,
      error: { code: "INVALID_QUANTILE_INPUT" },
    });
    expect(estimateQuantile([1, Number.NaN], 0.95, "LINEAR_R7")).toEqual({
      ok: false,
      error: { code: "INVALID_QUANTILE_INPUT" },
    });
    expect(estimateQuantile([1], 0.95, "UNKNOWN" as "LINEAR_R7")).toEqual({
      ok: false,
      error: { code: "INVALID_QUANTILE_INPUT" },
    });
  });

  it("applique NEAREST_RANK comme règle unique et rapporte l'accord", () => {
    const result = assessConfidenceQuantileSensitivity(
      RUN_KEYS,
      completeEvidence(),
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedEstimator).toBe("NEAREST_RANK");
    expect(result.value.selectedVerdict).toBe("TAIL_CONFIRMED");
    expect(result.value.selectedFailureReasons).toEqual([]);
    expect(result.value.sensitivityVerdict).toBe("AGREEMENT");
    expect(
      result.value.estimators.map(({ estimator }) => estimator),
    ).toEqual(["LINEAR_R7", "NEAREST_RANK", "LOWER", "HIGHER"]);
  });

  it("rend visible un désaccord sans re-sélectionner l'estimateur", () => {
    const evidence = completeEvidence().map((item) => {
      if (
        item.profile !== "POWER_THIRD" ||
        item.runKey !== RUN_KEYS[3] ||
        item.strategyId !== "breakout"
      ) {
        return item;
      }
      return {
        ...item,
        requestedNotionalSamples: [
          100, 100, 100, 100, 200, 200, 200, 200, 200, 401,
        ],
      };
    });
    const result = assessConfidenceQuantileSensitivity(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sensitivityVerdict).toBe("DISAGREEMENT");
    expect(result.value.selectedEstimator).toBe("NEAREST_RANK");
    expect(result.value.selectedVerdict).toBe("TAIL_NOT_CONFIRMED");
    expect(result.value.selectedFailureReasons).toEqual([
      "P95_MEDIAN_RATIO_LIMIT",
    ]);
    expect(
      result.value.estimators.find(({ estimator }) => estimator === "LOWER")
        ?.verdict,
    ).toBe("TAIL_CONFIRMED");
  });

  it("accepte exactement les bornes 600 USD et ratio deux", () => {
    const evidence = completeEvidence().map((item) =>
      item.profile === "POWER_THIRD" &&
      item.runKey === RUN_KEYS[3] &&
      item.strategyId === "breakout"
        ? {
            ...item,
            requestedNotionalSamples: [
              100, 100, 100, 100, 300, 300, 300, 300, 300, 600,
            ],
          }
        : item,
    );
    const result = assessConfidenceQuantileSensitivity(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok && result.value.selectedVerdict).toBe("TAIL_CONFIRMED");
  });

  it("conserve simultanément les motifs absolu, relatif et parent", () => {
    const evidence = completeEvidence().map((item) => {
      if (
        item.profile !== "POWER_THIRD" ||
        item.strategyId !== "ema-cross"
      ) {
        return item;
      }
      const outsideScale = [RUN_KEYS[0], RUN_KEYS[1]].includes(item.runKey);
      return {
        ...item,
        requestedNotionalSamples: outsideScale
          ? [50, 50, 50, 50, 50, 50, 50, 50, 50, 700]
          : item.requestedNotionalSamples,
      };
    });
    const result = assessConfidenceQuantileSensitivity(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok && result.value.selectedFailureReasons).toEqual([
      "BASE_CONFIRMATION_FAILED",
      "P95_NOTIONAL_LIMIT",
      "P95_MEDIAN_RATIO_LIMIT",
    ]);
  });

  it("refuse une matrice, une longueur ou un échantillon invalides", () => {
    expect(
      assessConfidenceQuantileSensitivity(
        RUN_KEYS,
        completeEvidence().slice(1),
        completeRunInvariants(),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_CONFIDENCE_QUANTILE_SENSITIVITY_EVIDENCE",
      },
    });
    const invalidLength = completeEvidence().map((item, index) =>
      index === 0 ? { ...item, requestedNotionalSamples: [1] } : item,
    );
    expect(
      assessConfidenceQuantileSensitivity(
        RUN_KEYS,
        invalidLength,
        completeRunInvariants(),
      ).ok,
    ).toBe(false);
    const invalidSample = completeEvidence().map((item, index) =>
      index === 0
        ? {
            ...item,
            requestedNotionalSamples: [
              ...item.requestedNotionalSamples.slice(0, -1),
              0,
            ],
          }
        : item,
    );
    expect(
      assessConfidenceQuantileSensitivity(
        RUN_KEYS,
        invalidSample,
        completeRunInvariants(),
      ).ok,
    ).toBe(false);
  });
});
