export type SignalSizingErrorCode =
  | "INVALID_TARGET_SIGNAL_NOTIONAL"
  | "INVALID_SIGNAL_REFERENCE_PRICE"
  | "INVALID_RESOLVED_SIGNAL_QUANTITY";

export interface SignalSizingError {
  readonly code: SignalSizingErrorCode;
}

export type SignalSizingResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: SignalSizingError };
