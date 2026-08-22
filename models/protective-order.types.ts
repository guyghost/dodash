import type { RegimeKind } from "./regime-filter.types.js";

export type RegimeExitArm =
  | { readonly mode: "NONE" }
  | {
      readonly mode: "FIXED_BPS";
      readonly stopLossBps: number;
      readonly takeProfitBps: number;
    };

export interface RegimeConditionalExitPolicy {
  readonly mode: "REGIME_CONDITIONAL";
  readonly bullish: RegimeExitArm;
  readonly bearish: RegimeExitArm;
  readonly range: RegimeExitArm;
  readonly warmUp: RegimeExitArm;
}

export type ProtectiveExitPolicy =
  | { readonly mode: "NONE" }
  | {
      readonly mode: "FIXED_BPS";
      readonly stopLossBps: number;
      readonly takeProfitBps: number;
    }
  | {
      readonly mode: "ATR_MULTIPLE";
      readonly stopAtrMultiple: number;
      readonly takeAtrMultiple: number;
    }
  | { readonly mode: "TRAILING_BPS"; readonly trailBps: number }
  | RegimeConditionalExitPolicy;

export type ActiveProtectiveExitPolicy = Exclude<
  ProtectiveExitPolicy,
  { readonly mode: "NONE" } | { readonly mode: "REGIME_CONDITIONAL" }
>;

export interface ProtectiveOrderPlan {
  readonly positionId: string;
  readonly quantity: number;
  readonly averageEntryPrice: number;
  readonly stopPrice: number;
  readonly takeProfitPrice: number | null;
  readonly anchorPrice: number;
  readonly armedAt: number;
  readonly policyMode: ActiveProtectiveExitPolicy["mode"];
}

export type ProtectiveExitKind = "STOP_LOSS" | "TAKE_PROFIT";
export type ProtectiveExitReason =
  | "GAP_OPEN"
  | "INTRABAR"
  | "AMBIGUOUS_STOP_FIRST";

export interface ProtectiveExitResolution {
  readonly status: "TRIGGERED";
  readonly kind: ProtectiveExitKind;
  readonly reason: ProtectiveExitReason;
  readonly referencePrice: number;
  readonly triggeredAt: number;
}

export interface ProtectiveExitSummaryInput {
  readonly kind: ProtectiveExitKind;
  readonly reason: ProtectiveExitReason;
}

export interface ProtectiveExitCounts {
  readonly protectiveExitCount: number;
  readonly stopLossExitCount: number;
  readonly takeProfitExitCount: number;
  readonly ambiguousExitCount: number;
}

export interface ProtectiveNoTrigger {
  readonly status: "NOT_TRIGGERED";
}

export type ProtectiveResolution =
  | ProtectiveExitResolution
  | ProtectiveNoTrigger;

export type ProtectiveOrderErrorCode =
  | "INVALID_PROTECTIVE_POLICY"
  | "INVALID_PROTECTIVE_PLAN"
  | "INVALID_PROTECTIVE_CANDLE"
  | "INVALID_PROTECTIVE_SEQUENCE";

export interface ProtectiveOrderError {
  readonly code: ProtectiveOrderErrorCode;
}

export type ProtectiveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtectiveOrderError };

export interface CreateProtectiveOrderPlanInput {
  readonly positionId: string;
  readonly quantity: number;
  readonly averageEntryPrice: number;
  readonly atr: number | null;
  readonly armedAt: number;
  readonly policy: ActiveProtectiveExitPolicy;
}

export interface ProtectiveOpen {
  readonly start: number;
  readonly open: number;
}

export interface ProtectiveRange {
  readonly start: number;
  readonly high: number;
  readonly low: number;
}

export type ProtectiveCancelReason =
  | "POSITION_CLOSED"
  | "STRATEGY_EXIT"
  | "REGIME_CHANGED";

export interface ProtectiveOrderInput {
  readonly policy: ActiveProtectiveExitPolicy;
}

export interface ProtectiveOrderContext {
  readonly policy: ActiveProtectiveExitPolicy;
  readonly plan: ProtectiveOrderPlan | null;
  readonly currentCandleStart: number | null;
  readonly currentOpen: number | null;
  readonly lastCandleStart: number | null;
  readonly resolution: ProtectiveExitResolution | null;
  readonly cancelReason: ProtectiveCancelReason | null;
  readonly lastError: ProtectiveOrderError | null;
}

export type ProtectiveOrderEvent =
  | {
      readonly type: "ARM_REQUESTED";
      readonly positionId: string;
      readonly quantity: number;
      readonly averageEntryPrice: number;
      readonly atr: number | null;
      readonly armedAt: number;
    }
  | {
      readonly type: "POSITION_INCREASED";
      readonly quantity: number;
      readonly averageEntryPrice: number;
      readonly atr: number | null;
      readonly updatedAt: number;
    }
  | {
      readonly type: "POSITION_REDUCED";
      readonly quantity: number;
      readonly updatedAt: number;
    }
  | { readonly type: "CANDLE_OPENED"; readonly start: number; readonly open: number }
  | {
      readonly type: "CANDLE_RANGE_REPLAYED";
      readonly start: number;
      readonly high: number;
      readonly low: number;
    }
  | {
      readonly type: "CANCEL_REQUESTED";
      readonly reason: ProtectiveCancelReason;
    };
