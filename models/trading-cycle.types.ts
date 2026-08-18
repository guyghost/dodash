export type ShutdownMode =
  | "none"
  | "stop"
  | "kill-switch"
  | "permission-revoked";

export type CycleOutcome =
  | "IDLE"
  | "RUNNING"
  | "NO_ACTION"
  | "RISK_REJECTED"
  | "ORDER_CONFIRMED"
  | "ORDER_REJECTED"
  | "CANCELLED"
  | "FAILED";

export type WorkflowPhase =
  | "schedule"
  | "market-data"
  | "indicators"
  | "strategies"
  | "allocation"
  | "risk"
  | "order-intent"
  | "authorization"
  | "execution"
  | "reconciliation"
  | "persistence"
  | "cancellation";

export type WorkflowErrorCode =
  | "CONTROL_PERMISSION_REQUIRED"
  | "TRADE_PERMISSION_REQUIRED"
  | "PERMISSION_REVOKED"
  | "DUPLICATE_ALARM"
  | "STALE_MARKET_DATA"
  | "RATE_LIMITED"
  | "NETWORK_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "INVALID_INDICATORS"
  | "STRATEGY_FAILURE"
  | "ALLOCATION_FAILURE"
  | "RISK_FAILURE"
  | "ORDER_INTENT_FAILURE"
  | "AUTHENTICATION_FAILURE"
  | "AUTHORIZATION_EXPIRED"
  | "ORDER_REJECTED"
  | "ORDER_OUTCOME_UNKNOWN"
  | "RECONCILIATION_FAILURE"
  | "PERSISTENCE_FAILURE"
  | "SCHEDULE_FAILURE"
  | "CANCELLATION_FAILURE";

export interface WorkflowError {
  readonly phase: WorkflowPhase;
  readonly code: WorkflowErrorCode;
  readonly retryable: boolean;
}

export interface ControlPermissions {
  readonly canControl: boolean;
  readonly canTrade: boolean;
}

export interface RetryLimits {
  readonly schedule: number;
  readonly marketData: number;
  readonly authorization: number;
  readonly execution: number;
  readonly reconciliation: number;
  readonly persistence: number;
}

export interface RetryAttempts {
  readonly schedule: number;
  readonly marketData: number;
  readonly authorization: number;
  readonly execution: number;
  readonly reconciliation: number;
  readonly persistence: number;
}

export interface TradingCycleInput {
  readonly agentId: string;
  readonly strategyIds: readonly string[];
  readonly maxMarketStalenessMs?: number;
  readonly retryLimits?: Partial<RetryLimits>;
}

export interface TradingCycleContext {
  readonly agentId: string;
  readonly strategyIds: readonly string[];
  readonly permissions: ControlPermissions;
  readonly cycleId: string | null;
  readonly triggeredAt: number | null;
  readonly nextWakeAt: number | null;
  readonly marketSnapshotId: string | null;
  readonly indicatorsId: string | null;
  readonly signalsId: string | null;
  readonly decisionId: string | null;
  readonly clientOrderId: string | null;
  readonly exchangeOrderId: string | null;
  readonly orderMayBeInFlight: boolean;
  readonly authorizationExpiresAt: number | null;
  readonly shutdownMode: ShutdownMode;
  readonly outcome: CycleOutcome;
  readonly lastError: WorkflowError | null;
  readonly maxMarketStalenessMs: number;
  readonly retryLimits: RetryLimits;
  readonly attempts: RetryAttempts;
}

export type TradingCycleEvent =
  | {
      readonly type: "START_REQUESTED";
      readonly permissions: ControlPermissions;
    }
  | { readonly type: "STOP_REQUESTED" }
  | { readonly type: "KILL_SWITCH_ENGAGED" }
  | { readonly type: "PERMISSION_REVOKED" }
  | { readonly type: "RESET" }
  | { readonly type: "SCHEDULE_SUCCEEDED"; readonly nextWakeAt: number }
  | { readonly type: "SCHEDULE_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "ALARM_FIRED";
      readonly cycleId: string;
      readonly triggeredAt: number;
    }
  | {
      readonly type: "MARKET_DATA_READY";
      readonly snapshotId: string;
      readonly candleClosedAt: number;
    }
  | { readonly type: "MARKET_DATA_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "INDICATORS_COMPUTED";
      readonly indicatorsId: string;
    }
  | { readonly type: "INDICATORS_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "STRATEGIES_EVALUATED";
      readonly signalsId: string;
    }
  | { readonly type: "STRATEGIES_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "ALLOCATION_COMPLETED";
      readonly decisionId: string;
      readonly orderCount: number;
    }
  | { readonly type: "ALLOCATION_FAILED"; readonly error: WorkflowError }
  | { readonly type: "RISK_APPROVED" }
  | { readonly type: "RISK_REJECTED" }
  | { readonly type: "RISK_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "ORDER_INTENT_PERSISTED";
      readonly clientOrderId: string;
    }
  | { readonly type: "ORDER_INTENT_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "AUTHORIZATION_READY";
      readonly expiresAt: number;
      readonly issuedAt: number;
    }
  | { readonly type: "AUTHORIZATION_FAILED"; readonly error: WorkflowError }
  | {
      readonly type: "ORDER_CONFIRMED";
      readonly exchangeOrderId: string;
    }
  | { readonly type: "ORDER_REJECTED"; readonly error: WorkflowError }
  | { readonly type: "ORDER_OUTCOME_UNKNOWN"; readonly error: WorkflowError }
  | {
      readonly type: "ORDER_RECONCILED";
      readonly exchangeOrderId: string | null;
    }
  | { readonly type: "RECONCILIATION_FAILED"; readonly error: WorkflowError }
  | { readonly type: "PERSIST_SUCCEEDED" }
  | { readonly type: "PERSIST_FAILED"; readonly error: WorkflowError }
  | { readonly type: "EFFECT_CANCELLED" }
  | { readonly type: "EFFECT_CANCEL_FAILED"; readonly error: WorkflowError }
  | { readonly type: "RETRY_TIMER_ELAPSED" };

