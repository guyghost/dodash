import type { P7LedgerManifest } from "./p7-prospective-ledger.js";

export interface P7PricingCommitRequest {
  readonly campaignId: string;
  readonly commandId: string;
  readonly productId: "BTC-USD" | "ETH-USD";
  readonly candleClosedAt: number;
}
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export const isP7PricingCommitRequest = (value: unknown,
  manifest: Pick<P7LedgerManifest, "campaignId" | "startAt" | "endAt">): value is P7PricingCommitRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 4 && Object.keys(v).every((k) => ["campaignId", "commandId", "productId", "candleClosedAt"].includes(k)) &&
    v.campaignId === manifest.campaignId && typeof v.commandId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.commandId) &&
    (v.productId === "BTC-USD" || v.productId === "ETH-USD") && timestamp(v.candleClosedAt) && v.candleClosedAt % 86_400_000 === 0 &&
    v.candleClosedAt >= manifest.startAt && v.candleClosedAt < manifest.endAt;
};

/** Checked immediately before COMMIT, not a guarantee about disk flush completion. */
export const evaluateP7PricingCommitClock = (scope: {
  readonly recordedAt: number; readonly commitCheckedAt: number; readonly sourceObservedAt: unknown;
  readonly candleClosedAt: number; readonly campaignEndAt: number; readonly simulatedFill: boolean;
}): "COMMIT_CLOCK_INVALID" | "PRICING_EXPIRED_BEFORE_COMMIT" | null => {
  if (!timestamp(scope.recordedAt) || !timestamp(scope.commitCheckedAt) || scope.commitCheckedAt < scope.recordedAt) return "COMMIT_CLOCK_INVALID";
  if (scope.simulatedFill && (!timestamp(scope.sourceObservedAt) || scope.sourceObservedAt > scope.recordedAt ||
    scope.commitCheckedAt - scope.sourceObservedAt > 5_000 || scope.commitCheckedAt > scope.candleClosedAt + 7_200_000 ||
    scope.commitCheckedAt >= scope.campaignEndAt)) return "PRICING_EXPIRED_BEFORE_COMMIT";
  return null;
};
