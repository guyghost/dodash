import type { ControlPermissions, WorkflowError } from "./trading-cycle.types.js";

export interface LiveAccountControlRetryLimits {
  readonly cancellation: number;
  readonly reconciliation: number;
  readonly flatten: number;
  readonly verification: number;
}

export interface LiveAccountControlAttempts {
  readonly cancellation: number;
  readonly reconciliation: number;
  readonly flatten: number;
  readonly verification: number;
}

export interface LiveAccountControlInput {
  readonly retryLimits?: Partial<LiveAccountControlRetryLimits>;
}

export interface LiveAccountControlContext {
  readonly productId: string | null;
  readonly flattenClientOrderPrefix: string | null;
  readonly permissions: ControlPermissions;
  readonly snapshotId: string | null;
  readonly totalBaseQuantity: number | null;
  readonly availableBaseQuantity: number | null;
  readonly dustQuantity: number | null;
  readonly openOrderCount: number | null;
  readonly flattenQuantity: number | null;
  readonly flattenOutcomeUnknown: boolean;
  readonly lastError: WorkflowError | null;
  readonly retryLimits: LiveAccountControlRetryLimits;
  readonly attempts: LiveAccountControlAttempts;
}

export type LiveAccountControlEvent =
  | {
      readonly type: "KILL_REQUESTED";
      readonly productId: string;
      readonly flattenClientOrderPrefix: string;
      readonly permissions: ControlPermissions;
    }
  | { readonly type: "ORDERS_CLEARED" }
  | {
      readonly type: "ACCOUNT_RECONCILED";
      readonly snapshotId: string;
      readonly totalBaseQuantity: number;
      readonly availableBaseQuantity: number;
      readonly dustQuantity: number;
      readonly openOrderCount: number;
    }
  | { readonly type: "FLATTEN_CONFIRMED" }
  | { readonly type: "FLATTEN_OUTCOME_UNKNOWN" }
  | { readonly type: "FLATTEN_REJECTED"; readonly error: WorkflowError }
  | { readonly type: "OPERATION_FAILED"; readonly error: WorkflowError }
  | { readonly type: "RETRY_TIMER_ELAPSED" };
