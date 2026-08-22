export type RegimeKind = "BULLISH" | "BEARISH" | "RANGE";

/**
 * Politique v1 : régime dérivé de l'écart instantané EMA fast/slow.
 *
 * - `thresholdBps` : écart EMA en points de base au-delà duquel un régime est
 *   détecté (ex. 100 = 1 %). Strictement positif et < 10000.
 * - `minObservations` : nombre minimal d'observations avant la première
 *   classification (>= 1).
 * - `confirmationCount` : nombre consécutif d'observations du même régime
 *   avant transition (>= 1).
 */
export interface EmaThresholdRegimePolicy {
  readonly mode: "EMA_THRESHOLD";
  readonly thresholdBps: number;
  readonly minObservations: number;
  readonly confirmationCount: number;
}

/**
 * Politique v2 : régime dérivé de la pente de l'EMA slow
 * (modèle `regime-slope.md`).
 *
 * - `slopeThresholdBps` : pente (en bps sur `slopePeriods` observations)
 *   au-delà de laquelle un régime est détecté. Strictement positif et < 10000.
 * - `slopePeriods` : fenêtre de calcul de la pente (>= 1). La classification
 *   est impossible (`null`, « pending ») tant que l'historique EMA slow est
 *   plus court que cette fenêtre.
 * - `minObservations` / `confirmationCount` : identiques à la v1.
 */
export interface EmaSlopeRegimePolicy {
  readonly mode: "EMA_SLOPE";
  readonly slopeThresholdBps: number;
  readonly slopePeriods: number;
  readonly minObservations: number;
  readonly confirmationCount: number;
}

/** Union discriminée : aucun mode absent ou inconnu ne peut être valide. */
export type RegimeFilterPolicy =
  | EmaThresholdRegimePolicy
  | EmaSlopeRegimePolicy;

export interface RegimeObservation {
  readonly start: number;
  readonly emaFast: number;
  readonly emaSlow: number;
}

export type RegimeFilterErrorCode =
  | "INVALID_REGIME_POLICY"
  | "INVALID_REGIME_OBSERVATION";

export interface RegimeFilterError {
  readonly code: RegimeFilterErrorCode;
}

export type RegimePermissionsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RegimeFilterError };

export type RegimePermissions = Readonly<
  Record<RegimeKind, readonly string[]>
>;

export interface RegimeFilterInput {
  readonly policy: RegimeFilterPolicy;
}

export interface RegimeFilterContext {
  readonly policy: RegimeFilterPolicy;
  readonly regime: RegimeKind | null;
  readonly observationCount: number;
  readonly pendingKind: RegimeKind | null;
  readonly pendingCount: number;
  readonly opposingKind: RegimeKind | null;
  readonly opposingCount: number;
  readonly lastObservationStart: number | null;
  /**
   * Historique borné des dernières valeurs d'EMA slow. Utilisé uniquement en
   * mode EMA_SLOPE (borne : `slopePeriods`) ; vide en mode EMA_THRESHOLD.
   */
  readonly emaSlowHistory: readonly number[];
  readonly lastError: RegimeFilterError | null;
  readonly stopReason: RegimeFilterStopReason | null;
}

export type RegimeFilterStopReason = "OPERATOR_STOP" | "SESSION_END";

export type RegimeFilterEvent =
  | { readonly type: "CANDLE_CLOSED"; readonly observation: RegimeObservation }
  | { readonly type: "STOP_REQUESTED"; readonly reason: RegimeFilterStopReason };
