import { describe, expect, it } from "vitest";

import {
  assessConfidenceCalibrationConfirmation,
  type ConfidenceCalibrationConfirmationObservation,
  type ConfidenceCalibrationConfirmationProfile,
  type ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";

const RUN_KEYS = Object.freeze(["ALGO:1", "FIL:1", "ALGO:2", "FIL:2"]);
const PROFILES = Object.freeze([
  "IDENTITY",
  "POWER_THIRD",
] as const satisfies readonly ConfidenceCalibrationConfirmationProfile[]);
const STRATEGIES = Object.freeze(["ema-cross", "breakout"] as const);

const medianByRun = (
  profile: ConfidenceCalibrationConfirmationProfile,
  strategyId: (typeof STRATEGIES)[number],
  runIndex: number,
): number => {
  if (profile === "IDENTITY") return strategyId === "ema-cross" ? 2 : 20;
  const values =
    strategyId === "ema-cross"
      ? [100, 120, 130, 140]
      : [200, 250, 300, 400];
  return values[runIndex] ?? 100;
};

const completeEvidence = (): ConfidenceCalibrationConfirmationObservation[] =>
  PROFILES.flatMap((profile) =>
    RUN_KEYS.flatMap((runKey, runIndex) =>
      STRATEGIES.map((strategyId) => {
        const medianRequestedNotional = medianByRun(
          profile,
          strategyId,
          runIndex,
        );
        return {
          profile,
          runKey,
          strategyId,
          evaluationCount: 300,
          activeSignalCount: 10,
          buySignalCount: 4,
          sellSignalCount: 6,
          medianRequestedNotional,
          p95RequestedNotional: medianRequestedNotional * 1.5,
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

describe("confidence calibration cross-asset confirmation", () => {
  it("confirme POWER_THIRD quand l'échelle, la couverture et les garde-fous passent", () => {
    const result = assessConfidenceCalibrationConfirmation(
      RUN_KEYS,
      completeEvidence(),
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("CONFIRMED");
    expect(result.value.failureReasons).toEqual([]);
    expect(result.value.medianRequestedNotionalByStrategy).toEqual({
      "ema-cross": 125,
      breakout: 275,
    });
    expect(result.value.inBandRunRateByStrategy).toEqual({
      "ema-cross": 1,
      breakout: 1,
    });
  });

  it("réfute une stabilité masquée par une médiane agrégée dans la bande", () => {
    const evidence = completeEvidence().map((item) => {
      if (item.profile !== "POWER_THIRD" || item.strategyId !== "ema-cross") {
        return item;
      }
      const runIndex = RUN_KEYS.indexOf(item.runKey);
      const medianRequestedNotional = [50, 50, 350, 350][runIndex] ?? 50;
      return {
        ...item,
        medianRequestedNotional,
        p95RequestedNotional: medianRequestedNotional * 1.5,
      };
    });
    const result = assessConfidenceCalibrationConfirmation(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBe("NOT_CONFIRMED");
    expect(result.value.medianRequestedNotionalByStrategy["ema-cross"]).toBe(
      200,
    );
    expect(result.value.inBandRunRateByStrategy["ema-cross"]).toBe(0.5);
    expect(result.value.failureReasons).toEqual(["RUN_COVERAGE_LIMIT"]);
  });

  it.each([
    [
      "INACTIVE_RUN",
      {
        activeSignalCount: 0,
        buySignalCount: 0,
        sellSignalCount: 0,
        medianRequestedNotional: null,
        p95RequestedNotional: null,
      },
    ],
    ["ALLOCATION_CAPPED", { capRate: 0.01 }],
    ["RISK_REDUCED", { riskRejectionRate: 0.01 }],
    ["DRAWDOWN_LIMIT", { maxDrawdown: 0.101 }],
    ["TURNOVER_LIMIT", { turnover: 10.01 }],
    ["FEE_LIMIT", { feeRate: 0.0101 }],
  ] as const)("conserve le motif fermé %s", (reason, overrides) => {
    const evidence = completeEvidence().map((item) =>
      item.profile === "POWER_THIRD" &&
      item.runKey === RUN_KEYS[0] &&
      item.strategyId === "ema-cross"
        ? { ...item, ...overrides }
        : item,
    );
    if (reason === "INACTIVE_RUN") {
      const identityIndex = evidence.findIndex(
        (item) =>
          item.profile === "IDENTITY" &&
          item.runKey === RUN_KEYS[0] &&
          item.strategyId === "ema-cross",
      );
      evidence[identityIndex] = {
        ...evidence[identityIndex]!,
        ...overrides,
      };
    }
    const result = assessConfidenceCalibrationConfirmation(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.verdict).toBe("NOT_CONFIRMED");
    expect(result.ok && result.value.failureReasons).toContain(reason);
  });

  it("accepte exactement les bornes de risque et une couverture de 75%", () => {
    const evidence = completeEvidence().map((item) => {
      if (item.profile !== "POWER_THIRD") return item;
      const outsideBand =
        item.strategyId === "ema-cross" && item.runKey === RUN_KEYS[0];
      return {
        ...item,
        medianRequestedNotional: outsideBand
          ? 50
          : item.medianRequestedNotional,
        p95RequestedNotional: outsideBand
          ? 75
          : item.p95RequestedNotional,
        maxDrawdown: 0.1,
        turnover: 10,
        feeRate: 0.01,
      };
    });
    const result = assessConfidenceCalibrationConfirmation(
      RUN_KEYS,
      evidence,
      completeRunInvariants(),
    );

    expect(result.ok && result.value.verdict).toBe("CONFIRMED");
    expect(
      result.ok && result.value.inBandRunRateByStrategy["ema-cross"],
    ).toBe(0.75);
  });

  it("refuse une matrice absente ou dupliquée", () => {
    const evidence = completeEvidence();
    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        evidence.slice(1),
        completeRunInvariants(),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE",
      },
    });
    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        [...evidence, evidence[0]!],
        completeRunInvariants(),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE",
      },
    });
  });

  it("refuse une preuve de run absente", () => {
    const invariants = completeRunInvariants();
    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        completeEvidence(),
        invariants.slice(1),
      ).ok,
    ).toBe(false);
  });

  it.each([
    "benchmarkUnchanged",
    "referenceScenarioUnchanged",
  ] as const)("refuse l'invariant de run %s quand il est faux", (field) => {
    const invariants = completeRunInvariants().map((item, index) =>
      index === 0 ? { ...item, [field]: false } : item,
    );

    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        completeEvidence(),
        invariants,
      ).ok,
    ).toBe(false);
  });

  it.each([
    { buySignalCount: 5 },
    { p95RequestedNotional: 1 },
    { capRate: 1.01 },
    { maxDrawdown: 1.01 },
    { turnover: Number.NaN },
  ])("refuse une observation hors domaine : %o", (overrides) => {
    const evidence = completeEvidence().map((item, index) =>
      index === 0 ? { ...item, ...overrides } : item,
    );

    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        evidence,
        completeRunInvariants(),
      ).ok,
    ).toBe(false);
  });

  it("refuse une calibration qui change le nombre ou la direction des signaux", () => {
    const evidence = completeEvidence().map((item) =>
      item.profile === "POWER_THIRD" &&
      item.runKey === RUN_KEYS[0] &&
      item.strategyId === "breakout"
        ? {
            ...item,
            activeSignalCount: 11,
            buySignalCount: 5,
            sellSignalCount: 6,
          }
        : item,
    );

    expect(
      assessConfidenceCalibrationConfirmation(
        RUN_KEYS,
        evidence,
        completeRunInvariants(),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_CONFIDENCE_CALIBRATION_CONFIRMATION_EVIDENCE",
      },
    });
  });
});
