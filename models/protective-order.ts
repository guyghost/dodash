import type {
  ActiveProtectiveExitPolicy,
  CreateProtectiveOrderPlanInput,
  ProtectiveExitResolution,
  ProtectiveOpen,
  ProtectiveOrderPlan,
  ProtectiveRange,
  ProtectiveResolution,
  ProtectiveResult,
} from "./protective-order.types.js";

const ok = <T>(value: T): ProtectiveResult<T> =>
  Object.freeze({ ok: true as const, value });
const err = <T>(
  code: "INVALID_PROTECTIVE_POLICY" | "INVALID_PROTECTIVE_PLAN" | "INVALID_PROTECTIVE_CANDLE",
): ProtectiveResult<T> => Object.freeze({ ok: false as const, error: { code } });
const positiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;
const validTimestamp = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const isValidProtectiveExitPolicy = (
  policy: ActiveProtectiveExitPolicy,
): boolean =>
  policy.mode === "FIXED_BPS"
    ? positiveFinite(policy.stopLossBps) &&
      policy.stopLossBps < 10_000 &&
      positiveFinite(policy.takeProfitBps) &&
      policy.takeProfitBps < 100_000
    : positiveFinite(policy.stopAtrMultiple) &&
      positiveFinite(policy.takeAtrMultiple);

export const createProtectiveOrderPlan = (
  input: CreateProtectiveOrderPlanInput,
): ProtectiveResult<ProtectiveOrderPlan> => {
  if (!isValidProtectiveExitPolicy(input.policy)) {
    return err("INVALID_PROTECTIVE_POLICY");
  }
  if (
    input.positionId.trim().length === 0 ||
    !positiveFinite(input.quantity) ||
    !positiveFinite(input.averageEntryPrice) ||
    !validTimestamp(input.armedAt) ||
    (input.policy.mode === "ATR_MULTIPLE" &&
      (input.atr === null || !positiveFinite(input.atr)))
  ) {
    return err("INVALID_PROTECTIVE_PLAN");
  }
  const stopDistance =
    input.policy.mode === "FIXED_BPS"
      ? input.averageEntryPrice * (input.policy.stopLossBps / 10_000)
      : (input.atr as number) * input.policy.stopAtrMultiple;
  const takeDistance =
    input.policy.mode === "FIXED_BPS"
      ? input.averageEntryPrice * (input.policy.takeProfitBps / 10_000)
      : (input.atr as number) * input.policy.takeAtrMultiple;
  const stopPrice = input.averageEntryPrice - stopDistance;
  const takeProfitPrice = input.averageEntryPrice + takeDistance;
  if (
    !positiveFinite(stopPrice) ||
    !positiveFinite(takeProfitPrice) ||
    stopPrice >= input.averageEntryPrice ||
    takeProfitPrice <= input.averageEntryPrice
  ) {
    return err("INVALID_PROTECTIVE_PLAN");
  }
  return ok(
    Object.freeze({
      positionId: input.positionId,
      quantity: input.quantity,
      averageEntryPrice: input.averageEntryPrice,
      stopPrice,
      takeProfitPrice,
      armedAt: input.armedAt,
      policyMode: input.policy.mode,
    }),
  );
};

const trigger = (
  kind: ProtectiveExitResolution["kind"],
  reason: ProtectiveExitResolution["reason"],
  referencePrice: number,
  triggeredAt: number,
): ProtectiveExitResolution =>
  Object.freeze({
    status: "TRIGGERED",
    kind,
    reason,
    referencePrice,
    triggeredAt,
  });

export const resolveProtectiveOpen = (
  plan: ProtectiveOrderPlan,
  candle: ProtectiveOpen,
): ProtectiveResult<ProtectiveResolution> => {
  if (
    !validTimestamp(candle.start) ||
    candle.start < plan.armedAt ||
    !positiveFinite(candle.open)
  ) {
    return err("INVALID_PROTECTIVE_CANDLE");
  }
  if (candle.open <= plan.stopPrice) {
    return ok(trigger("STOP_LOSS", "GAP_OPEN", candle.open, candle.start));
  }
  if (candle.open >= plan.takeProfitPrice) {
    return ok(trigger("TAKE_PROFIT", "GAP_OPEN", candle.open, candle.start));
  }
  return ok(Object.freeze({ status: "NOT_TRIGGERED" as const }));
};

export const resolveProtectiveRange = (
  plan: ProtectiveOrderPlan,
  candle: ProtectiveRange,
): ProtectiveResult<ProtectiveResolution> => {
  if (
    !validTimestamp(candle.start) ||
    candle.start < plan.armedAt ||
    !positiveFinite(candle.high) ||
    !positiveFinite(candle.low) ||
    candle.low > candle.high
  ) {
    return err("INVALID_PROTECTIVE_CANDLE");
  }
  const stopHit = candle.low <= plan.stopPrice;
  const takeHit = candle.high >= plan.takeProfitPrice;
  if (stopHit && takeHit) {
    return ok(
      trigger(
        "STOP_LOSS",
        "AMBIGUOUS_STOP_FIRST",
        plan.stopPrice,
        candle.start,
      ),
    );
  }
  if (stopHit) {
    return ok(trigger("STOP_LOSS", "INTRABAR", plan.stopPrice, candle.start));
  }
  if (takeHit) {
    return ok(
      trigger("TAKE_PROFIT", "INTRABAR", plan.takeProfitPrice, candle.start),
    );
  }
  return ok(Object.freeze({ status: "NOT_TRIGGERED" as const }));
};
