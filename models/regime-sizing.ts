// Source de vérité — models/regime-sizing.md
// Sizing conditionné par régime : résolution de l'exposant de calibration
// de confiance par bras de régime. Miroir de resolveRegimeExitArm
// (models/protective-order.ts) : total sur RegimeKind ∪ {null}, aucune
// transition implicite. INV-S5 : ce résolveur est l'unique source de
// l'exposant appliqué — le replay ne contient aucune table d'exposants.

import {
  isConfidenceCalibrationProfile,
  type ConfidenceCalibrationProfile,
} from "./confidence-calibration.js";
import type { RegimeKind } from "./regime-filter.types.js";

export interface RegimeConditionalSizingPolicy {
  readonly bullish: ConfidenceCalibrationProfile;
  readonly bearish: ConfidenceCalibrationProfile;
  readonly range: ConfidenceCalibrationProfile;
  readonly warmUp: ConfidenceCalibrationProfile;
}

export const isValidRegimeConditionalSizingPolicy = (
  policy: RegimeConditionalSizingPolicy,
): boolean =>
  isConfidenceCalibrationProfile(policy.bullish) &&
  isConfidenceCalibrationProfile(policy.bearish) &&
  isConfidenceCalibrationProfile(policy.range) &&
  isConfidenceCalibrationProfile(policy.warmUp);

// INV-S3 : total sur RegimeKind ∪ {null} — régime null (warm-up) → bras
// warmUp, jamais de chemin par défaut implicite.
export const resolveRegimeSizingProfile = (
  policy: RegimeConditionalSizingPolicy,
  regime: RegimeKind | null,
): ConfidenceCalibrationProfile =>
  regime === null
    ? policy.warmUp
    : regime === "BULLISH"
      ? policy.bullish
      : regime === "BEARISH"
        ? policy.bearish
        : policy.range;
