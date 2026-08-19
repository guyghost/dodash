import type {
  SignalSizingErrorCode,
  SignalSizingResult,
} from "./signal-sizing.types.js";

const error = (code: SignalSizingErrorCode): SignalSizingResult =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code }) });

const positiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

export const resolveTargetSignalQuantity = (
  targetSignalNotional: number,
  referencePrice: number,
): SignalSizingResult => {
  if (!positiveFinite(targetSignalNotional)) {
    return error("INVALID_TARGET_SIGNAL_NOTIONAL");
  }
  if (!positiveFinite(referencePrice)) {
    return error("INVALID_SIGNAL_REFERENCE_PRICE");
  }
  const quantity = targetSignalNotional / referencePrice;
  return positiveFinite(quantity)
    ? Object.freeze({ ok: true as const, value: quantity })
    : error("INVALID_RESOLVED_SIGNAL_QUANTITY");
};
