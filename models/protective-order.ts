import type {
  ActiveProtectiveExitPolicy,
  CreateProtectiveOrderPlanInput,
  ProtectiveExitResolution,
  ProtectiveExitCounts,
  ProtectiveExitSummaryInput,
  ProtectiveOpen,
  ProtectiveOrderPlan,
  ProtectiveRange,
  ProtectiveResolution,
  ProtectiveResult,
  RegimeConditionalExitPolicy,
  RegimeExitArm,
} from "./protective-order.types.js";
import type { RegimeKind } from "./regime-filter.types.js";

export const summarizeProtectiveExits = (
  exits: readonly ProtectiveExitSummaryInput[],
): ProtectiveExitCounts => {
  let stopLossExitCount = 0;
  let takeProfitExitCount = 0;
  let ambiguousExitCount = 0;
  for (const exit of exits) {
    if (exit.kind === "STOP_LOSS") stopLossExitCount += 1;
    else takeProfitExitCount += 1;
    if (exit.reason === "AMBIGUOUS_STOP_FIRST") ambiguousExitCount += 1;
  }
  return Object.freeze({
    protectiveExitCount: stopLossExitCount + takeProfitExitCount,
    stopLossExitCount,
    takeProfitExitCount,
    ambiguousExitCount,
  });
};

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
): boolean => {
  if (policy.mode === "FIXED_BPS") {
    return (
      positiveFinite(policy.stopLossBps) &&
      policy.stopLossBps < 10_000 &&
      positiveFinite(policy.takeProfitBps) &&
      policy.takeProfitBps < 100_000
    );
  }
  if (policy.mode === "ATR_MULTIPLE") {
    return (
      positiveFinite(policy.stopAtrMultiple) &&
      positiveFinite(policy.takeAtrMultiple)
    );
  }
  return positiveFinite(policy.trailBps) && policy.trailBps < 10_000;
};

export const isValidRegimeExitArm = (arm: RegimeExitArm): boolean =>
  arm.mode === "NONE" ||
  (positiveFinite(arm.stopLossBps) &&
    arm.stopLossBps < 10_000 &&
    positiveFinite(arm.takeProfitBps) &&
    arm.takeProfitBps < 100_000);

export const isValidRegimeConditionalExitPolicy = (
  policy: RegimeConditionalExitPolicy,
): boolean =>
  isValidRegimeExitArm(policy.bullish) &&
  isValidRegimeExitArm(policy.bearish) &&
  isValidRegimeExitArm(policy.range) &&
  isValidRegimeExitArm(policy.warmUp);

export const resolveRegimeExitArm = (
  policy: RegimeConditionalExitPolicy,
  regime: RegimeKind | null,
): ActiveProtectiveExitPolicy | null => {
  const arm =
    regime === null
      ? policy.warmUp
      : regime === "BULLISH"
        ? policy.bullish
        : regime === "BEARISH"
          ? policy.bearish
          : policy.range;
  return arm.mode === "NONE" ? null : arm;
};

export const activeProtectivePolicyEquals = (
  a: ActiveProtectiveExitPolicy | null,
  b: ActiveProtectiveExitPolicy | null,
): boolean => {
  if (a === null || b === null) return a === b;
  if (a.mode !== b.mode) return false;
  if (a.mode === "FIXED_BPS" && b.mode === "FIXED_BPS") {
    return (
      a.stopLossBps === b.stopLossBps && a.takeProfitBps === b.takeProfitBps
    );
  }
  if (a.mode === "ATR_MULTIPLE" && b.mode === "ATR_MULTIPLE") {
    return (
      a.stopAtrMultiple === b.stopAtrMultiple &&
      a.takeAtrMultiple === b.takeAtrMultiple
    );
  }
  if (a.mode === "TRAILING_BPS" && b.mode === "TRAILING_BPS") {
    return a.trailBps === b.trailBps;
  }
  return false;
};

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
  const stopPrice =
    input.policy.mode === "FIXED_BPS"
      ? input.averageEntryPrice -
        input.averageEntryPrice * (input.policy.stopLossBps / 10_000)
      : input.policy.mode === "TRAILING_BPS"
        ? input.averageEntryPrice * (1 - input.policy.trailBps / 10_000)
        : input.averageEntryPrice -
          (input.atr as number) * input.policy.stopAtrMultiple;
  if (input.policy.mode === "TRAILING_BPS") {
    if (!positiveFinite(stopPrice) || stopPrice >= input.averageEntryPrice) {
      return err("INVALID_PROTECTIVE_PLAN");
    }
    return ok(
      Object.freeze({
        positionId: input.positionId,
        quantity: input.quantity,
        averageEntryPrice: input.averageEntryPrice,
        stopPrice,
        takeProfitPrice: null,
        anchorPrice: input.averageEntryPrice,
        armedAt: input.armedAt,
        policyMode: input.policy.mode,
      }),
    );
  }
  const takeDistance =
    input.policy.mode === "FIXED_BPS"
      ? input.averageEntryPrice * (input.policy.takeProfitBps / 10_000)
      : (input.atr as number) * input.policy.takeAtrMultiple;
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
      anchorPrice: input.averageEntryPrice,
      armedAt: input.armedAt,
      policyMode: input.policy.mode,
    }),
  );
};

export const advanceTrailingPlan = (
  plan: ProtectiveOrderPlan,
  policy: ActiveProtectiveExitPolicy,
  candle: ProtectiveRange,
): ProtectiveOrderPlan => {
  if (
    policy.mode !== "TRAILING_BPS" ||
    plan.policyMode !== "TRAILING_BPS" ||
    candle.high <= plan.anchorPrice
  ) {
    return plan;
  }
  const anchorPrice = candle.high;
  const stopPrice = Math.max(
    plan.stopPrice,
    anchorPrice * (1 - policy.trailBps / 10_000),
  );
  return Object.freeze({ ...plan, anchorPrice, stopPrice });
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
  const takeProfitPrice = plan.takeProfitPrice;
  if (takeProfitPrice !== null && candle.open >= takeProfitPrice) {
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
  const takeProfitPrice = plan.takeProfitPrice;
  const takeHit = takeProfitPrice !== null && candle.high >= takeProfitPrice;
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
      trigger("TAKE_PROFIT", "INTRABAR", takeProfitPrice, candle.start),
    );
  }
  return ok(Object.freeze({ status: "NOT_TRIGGERED" as const }));
};
