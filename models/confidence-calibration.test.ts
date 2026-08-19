import { describe, expect, it } from "vitest";

import {
  calibrateConfidence,
  CONFIDENCE_CALIBRATION_PROFILES,
  selectConfidenceCalibrationProfile,
  type ConfidenceCalibrationDevelopmentObservation,
  type ConfidenceCalibrationProfile,
} from "./confidence-calibration.js";

describe("confidence calibration", () => {
  it("applique les quatre profils fermés", () => {
    const raw = 1 / 64;
    const expected: Readonly<Record<ConfidenceCalibrationProfile, number>> = {
      IDENTITY: 1 / 64,
      POWER_HALF: 1 / 8,
      POWER_THIRD: 1 / 4,
      POWER_QUARTER: 1 / Math.sqrt(8),
    };

    for (const profile of CONFIDENCE_CALIBRATION_PROFILES) {
      const result = calibrateConfidence(profile, raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeCloseTo(expected[profile], 12);
    }
  });

  it("préserve les bornes, la monotonie et l'ordre de force", () => {
    for (const profile of CONFIDENCE_CALIBRATION_PROFILES) {
      expect(calibrateConfidence(profile, 0)).toEqual({ ok: true, value: 0 });
      expect(calibrateConfidence(profile, 1)).toEqual({ ok: true, value: 1 });
    }

    const rawValues = [0.001, 0.01, 0.1, 0.5];
    for (const raw of rawValues) {
      const values = CONFIDENCE_CALIBRATION_PROFILES.map((profile) => {
        const result = calibrateConfidence(profile, raw);
        if (!result.ok) throw new Error(result.error.code);
        return result.value;
      });
      expect(values).toEqual([...values].sort((left, right) => left - right));
    }
  });

  it.each([
    ["UNKNOWN", 0.5, "INVALID_CONFIDENCE_CALIBRATION_PROFILE"],
    ["IDENTITY", -0.1, "INVALID_RAW_CONFIDENCE"],
    ["IDENTITY", Number.NaN, "INVALID_RAW_CONFIDENCE"],
    ["IDENTITY", 1.1, "INVALID_RAW_CONFIDENCE"],
  ])("refuse un profil ou une confiance invalide", (profile, raw, code) => {
    expect(calibrateConfidence(profile, raw)).toEqual({
      ok: false,
      error: { code },
    });
  });
});

const observation = (
  profile: ConfidenceCalibrationProfile,
  runKey: string,
  strategyId: "ema-cross" | "breakout",
  medianRequestedNotional: number,
  overrides: Partial<ConfidenceCalibrationDevelopmentObservation> = {},
): ConfidenceCalibrationDevelopmentObservation => ({
  profile,
  runKey,
  strategyId,
  activeSignalCount: 4,
  medianRequestedNotional,
  capRate: 0,
  riskRejectionRate: 0,
  maxDrawdown: 0.02,
  turnover: 1.5,
  feeRate: 0.001,
  ...overrides,
});

const completeEvidence = (): ConfidenceCalibrationDevelopmentObservation[] => {
  const medians: Readonly<
    Record<ConfidenceCalibrationProfile, readonly [number, number]>
  > = {
    IDENTITY: [10, 30],
    POWER_HALF: [80, 180],
    POWER_THIRD: [150, 250],
    POWER_QUARTER: [300, 500],
  };
  return CONFIDENCE_CALIBRATION_PROFILES.flatMap((profile) =>
    ["ETC:2022", "ATOM:2022"].flatMap((runKey) => [
      observation(profile, runKey, "ema-cross", medians[profile][0]),
      observation(profile, runKey, "breakout", medians[profile][1]),
    ]),
  );
};

describe("confidence calibration selection", () => {
  it("sélectionne le profil le moins fort qui respecte la bande", () => {
    const result = selectConfidenceCalibrationProfile(
      ["ETC:2022", "ATOM:2022"],
      completeEvidence(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedProfile).toBe("POWER_THIRD");
    expect(
      result.value.candidates.map(({ profile, eligible }) => ({
        profile,
        eligible,
      })),
    ).toEqual([
      { profile: "IDENTITY", eligible: false },
      { profile: "POWER_HALF", eligible: false },
      { profile: "POWER_THIRD", eligible: true },
      { profile: "POWER_QUARTER", eligible: false },
    ]);
  });

  it("applique les garde-fous avant l'ordre de force", () => {
    const evidence = completeEvidence().map((item) =>
      item.profile === "POWER_THIRD" && item.runKey === "ETC:2022"
        ? { ...item, capRate: 0.01 }
        : item.profile === "POWER_QUARTER"
          ? {
              ...item,
              medianRequestedNotional:
                item.strategyId === "ema-cross" ? 280 : 360,
            }
          : item,
    );
    const result = selectConfidenceCalibrationProfile(
      ["ETC:2022", "ATOM:2022"],
      evidence,
    );

    expect(result.ok && result.value.selectedProfile).toBe("POWER_QUARTER");
    expect(
      result.ok &&
        result.value.candidates.find(({ profile }) => profile === "POWER_THIRD")
          ?.ineligibilityReasons,
    ).toContain("ALLOCATION_CAPPED");
  });

  it.each([
    [
      "INACTIVE_RUN",
      { activeSignalCount: 0, medianRequestedNotional: null },
    ],
    ["RISK_REDUCED", { riskRejectionRate: 0.01 }],
    ["DRAWDOWN_LIMIT", { maxDrawdown: 0.11 }],
    ["TURNOVER_LIMIT", { turnover: 11 }],
    ["FEE_LIMIT", { feeRate: 0.011 }],
  ] as const)("refuse un profil qui déclenche %s", (reason, overrides) => {
    const evidence = completeEvidence().map((item) =>
      item.profile === "POWER_THIRD" && item.runKey === "ETC:2022"
        ? { ...item, ...overrides }
        : item,
    );
    const result = selectConfidenceCalibrationProfile(
      ["ETC:2022", "ATOM:2022"],
      evidence,
    );

    expect(result.ok).toBe(true);
    expect(
      result.ok &&
        result.value.candidates.find(({ profile }) => profile === "POWER_THIRD")
          ?.ineligibilityReasons,
    ).toContain(reason);
  });

  it("refuse une matrice de développement incomplète ou dupliquée", () => {
    const evidence = completeEvidence();
    expect(
      selectConfidenceCalibrationProfile(
        ["ETC:2022", "ATOM:2022"],
        evidence.slice(1),
      ),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_CONFIDENCE_CALIBRATION_EVIDENCE" },
    });
    expect(
      selectConfidenceCalibrationProfile(
        ["ETC:2022", "ATOM:2022"],
        [...evidence, evidence[0]!],
      ),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_CONFIDENCE_CALIBRATION_EVIDENCE" },
    });
  });
});
