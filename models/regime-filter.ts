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

const hasValidSharedFields = (policy: RegimeFilterPolicy): boolean =>
  Number.isInteger(policy.minObservations) &&
  policy.minObservations >= 1 &&
  Number.isInteger(policy.confirmationCount) &&
  policy.confirmationCount >= 1;

const isValidBps = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value < 10_000;

/**
 * Validation par mode : les champs spécifiques à un mode ne doivent pas être
 * utilisés par l'autre, et tout mode inconnu est rejeté (R6).
 */
export const isValidRegimeFilterPolicy = (
  policy: RegimeFilterPolicy,
): boolean => {
  if (!hasValidSharedFields(policy)) return false;
  if (policy.mode === "EMA_THRESHOLD") {
    return (
      isValidBps(policy.thresholdBps) &&
      (policy.bearishThresholdBps === undefined ||
        isValidBps(policy.bearishThresholdBps))
    );
  }
  if (policy.mode === "EMA_SLOPE") {
    return (
      isValidBps(policy.slopeThresholdBps) &&
      Number.isInteger(policy.slopePeriods) &&
      policy.slopePeriods >= 1
    );
  }
  return false;
};

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

// INV-P2 (models/strategy-permission.md) : la table doit être totale sur
// RegimeKind — chaque régime a une liste (éventuellement vide = régime
// interdit à tous, candidats C1/C2), sans doublon ni id vide.
const REGIME_KINDS: readonly RegimeKind[] = ["BULLISH", "BEARISH", "RANGE"];

export const isValidRegimePermissions = (
  value: RegimePermissions,
): boolean =>
  typeof value === "object" &&
  value !== null &&
  REGIME_KINDS.every((kind) => Array.isArray(value[kind])) &&
  REGIME_KINDS.every((kind) =>
    value[kind].every(
      (id, index) =>
        typeof id === "string" &&
        id.trim().length > 0 &&
        value[kind].indexOf(id) === index,
    ),
  );

/**
 * Classification d'une observation selon le mode de la politique.
 *
 * - EMA_THRESHOLD : écart instantané EMA fast/slow (v1, jamais `null`).
 * - EMA_SLOPE : pente de l'EMA slow sur `slopePeriods` observations, mesurée
 *   entre l'observation courante et `emaSlowHistory[0]`. Retourne `null`
 *   (« pending ») tant que l'historique est insuffisant — ce n'est pas une
 *   erreur (modèle regime-slope.md, invariants 10-13).
 *
 * @param emaSlowHistory Historique borné des EMA slow précédentes
 *   (l'observation courante n'y est PAS encore). Ignéré en EMA_THRESHOLD.
 */
export const classifyRegimeObservation = (
  policy: RegimeFilterPolicy,
  observation: RegimeObservation,
  emaSlowHistory: readonly number[] = [],
): RegimeKind | null => {
  if (policy.mode === "EMA_THRESHOLD") {
    const threshold = 1 + policy.thresholdBps / 10_000;
    if (observation.emaFast > observation.emaSlow * threshold) return "BULLISH";
    // Asymétrie v3 : sans `bearishThresholdBps`, `bearThreshold` est
    // numériquement égal à `threshold` → classification bit-identique v1
    // (inégalités strictes conservées, sans epsilon).
    const bearThreshold =
      1 + (policy.bearishThresholdBps ?? policy.thresholdBps) / 10_000;
    if (observation.emaFast < observation.emaSlow * (2 - bearThreshold)) {
      return "BEARISH";
    }
    return "RANGE";
  }
  if (emaSlowHistory.length < policy.slopePeriods) return null;
  const reference = emaSlowHistory[0];
  if (reference === undefined || reference <= 0) return null;
  const slopeBps = (observation.emaSlow / reference - 1) * 10_000;
  // Inégalités strictes (au-seuil = RANGE) rendues robustes aux artefacts
  // flottants (ex. 101/100 − 1 ≈ 100.0000000009 bps).
  const epsilon = 1e-6;
  if (slopeBps > policy.slopeThresholdBps + epsilon) return "BULLISH";
  if (slopeBps < -(policy.slopeThresholdBps + epsilon)) return "BEARISH";
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
