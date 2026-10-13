import type { MarketAdmission, TradingCycleContext } from "./trading-cycle.types.js";

type AdmissionContext = Pick<TradingCycleContext,
  "cycleId" | "triggeredAt" | "lastDecisionCandleClosedAt" | "maxMarketStalenessMs">;

/** Diagnostic-only normalization; this fact never selects a trading transition. */
export const normalizeMarketAdmission = (value: unknown, context: AdmissionContext): MarketAdmission | null => {
  if (value === null || typeof value !== "object") return null;
  const admission = value as Record<string, unknown>;
  const { cycleId, candleClosedAt, evaluatedAt } = admission;
  const trigger = context.triggeredAt;
  if (
    typeof cycleId !== "string" || cycleId.length === 0 || cycleId.length > 128 ||
    cycleId !== context.cycleId ||
    typeof candleClosedAt !== "number" || !Number.isSafeInteger(candleClosedAt) || candleClosedAt < 0 ||
    typeof evaluatedAt !== "number" || !Number.isSafeInteger(evaluatedAt) ||
    trigger === null || !Number.isSafeInteger(trigger) || trigger < 0 ||
    candleClosedAt !== context.lastDecisionCandleClosedAt || candleClosedAt > trigger ||
    evaluatedAt < trigger || !Number.isFinite(context.maxMarketStalenessMs) ||
    context.maxMarketStalenessMs < 0 || evaluatedAt - candleClosedAt > context.maxMarketStalenessMs
  ) return null;
  return Object.freeze({ cycleId, candleClosedAt, evaluatedAt });
};

export const projectDecisionAdmission = (context: TradingCycleContext) => {
  const admission = normalizeMarketAdmission(context.marketAdmission, context);
  return Object.freeze({
    cycleId: context.cycleId,
    triggeredAt: context.triggeredAt,
    decisionAdmissionStatus: admission === null ? "UNOBSERVED" as const : "ADMITTED" as const,
    decisionCandleClosedAt: admission?.candleClosedAt ?? null,
    decisionEvaluatedAt: admission?.evaluatedAt ?? null,
  });
};
