export type RegimeKind = "BULLISH" | "BEARISH" | "RANGE";

export interface RegimeFilterPolicy {
  readonly thresholdBps: number;
  readonly minObservations: number;
  readonly confirmationCount: number;
}

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
  readonly lastError: RegimeFilterError | null;
  readonly stopReason: RegimeFilterStopReason | null;
}

export type RegimeFilterStopReason = "OPERATOR_STOP" | "SESSION_END";

export type RegimeFilterEvent =
  | { readonly type: "CANDLE_CLOSED"; readonly observation: RegimeObservation }
  | { readonly type: "STOP_REQUESTED"; readonly reason: RegimeFilterStopReason };
