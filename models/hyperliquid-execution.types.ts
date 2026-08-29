export const HYPERLIQUID_PERP_VENUE = "HYPERLIQUID";

export type HyperliquidPerpProduct = "BTC-PERP" | "ETH-PERP";

export interface HyperliquidRiskEnvelope {
  readonly maxOrderNotional: number;
  readonly maxPositionNotional: number;
  readonly maxGrossExposure: number;
  readonly maxDailyLoss: number;
}

export interface HyperliquidPerpCandidate {
  readonly executionMode: "paper" | "live";
  readonly venue: string;
  readonly productId: string;
  readonly timeframe: string;
  readonly maxLeverage: number;
  readonly risk: HyperliquidRiskEnvelope;
}

export type HyperliquidPerpAdmission =
  | { readonly status: "APPROVED" }
  | { readonly status: "OUT_OF_SCOPE" }
  | {
      readonly status: "REJECTED";
      readonly reasonCode:
        | "PERP_PRODUCT_NOT_ALLOWED"
        | "PERP_POLICY_MISMATCH";
    };

export interface PerpOrderIntent {
  readonly productId: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly markPrice: number;
  readonly leverage: number;
}

export interface PerpRiskGate {
  readonly admissionApproved: boolean;
  readonly positionQuantity: number;
  readonly dailyPnl: number;
  readonly otherGrossExposureNotional: number;
}

export type PerpRefusalCode =
  | "PERP_INTENT_INVALID"
  | "AGENT_WALLET_NOT_READY"
  | "PERP_ADMISSION_REQUIRED"
  | "PERP_PRODUCT_NOT_ALLOWED"
  | "PERP_LEVERAGE_EXCEEDED"
  | "PERP_DAILY_LOSS_BREACHED"
  | "PERP_ORDER_NOTIONAL_EXCEEDED"
  | "PERP_POSITION_EXCEEDED"
  | "PERP_EXPOSURE_EXCEEDED";

export type PerpOrderAssessment =
  | { readonly status: "EXECUTABLE" }
  | { readonly status: "REFUSED"; readonly reasonCode: PerpRefusalCode };

export interface PerpExecutionError {
  readonly code:
    | "PERSIST_INTENT_FAILED"
    | "SIGN_FAILED"
    | "RECONCILIATION_FAILED"
    | "PERSIST_OUTCOME_FAILED";
}

export interface PerpOrderGateInput {
  readonly intent: PerpOrderIntent;
  readonly gate: PerpRiskGate;
  readonly clientOrderId: string;
  readonly signerReady: boolean;
}

export type HyperliquidOrderOutcome = "ACCEPTED" | "REJECTED";

export interface HyperliquidPerpOrderContext {
  readonly clientOrderId: string | null;
  readonly intent: PerpOrderIntent | null;
  readonly outcome: HyperliquidOrderOutcome | null;
  readonly lastRefusal: PerpRefusalCode | null;
  readonly lastError: PerpExecutionError | null;
}

export type HyperliquidPerpOrderEvent =
  | {
      readonly type: "ORDER_INTENT_REQUESTED";
      readonly intent: PerpOrderIntent;
      readonly gate: PerpRiskGate;
      readonly clientOrderId: string;
      readonly signerReady: boolean;
    }
  | {
      readonly type: "ORDER_RECOVERY_REQUESTED";
      readonly intent: PerpOrderIntent;
      readonly clientOrderId: string;
    }
  | { readonly type: "INTENT_PERSIST_SUCCEEDED" }
  | { readonly type: "INTENT_PERSIST_FAILED"; readonly error: PerpExecutionError }
  | { readonly type: "ACTION_SIGNED" }
  | { readonly type: "SIGN_FAILED"; readonly error: PerpExecutionError }
  | { readonly type: "SUBMIT_ACCEPTED" }
  | { readonly type: "SUBMIT_REJECTED" }
  | { readonly type: "SUBMIT_UNKNOWN" }
  | {
      readonly type: "RECONCILIATION_RESOLVED";
      readonly outcome: HyperliquidOrderOutcome;
    }
  | { readonly type: "RECONCILIATION_FAILED"; readonly error: PerpExecutionError }
  | { readonly type: "PERSIST_SUCCEEDED" }
  | { readonly type: "PERSIST_FAILED"; readonly error: PerpExecutionError }
  | { readonly type: "RESET" };

export interface HyperliquidPerpOrderInput {
  readonly signerReady?: boolean;
}
