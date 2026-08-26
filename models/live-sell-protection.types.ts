import type { ControlPermissions, WorkflowError } from "./trading-cycle.types.js";

export type LiveSellProtectionOutcome =
  | "IDLE"
  | "NO_SELL_NEEDED"
  | "SOLD_FLAT"
  | "SOLD_REPROTECTED"
  | "FLATTENED_AFTER_FAILURE"
  | "FAILED";

export interface LiveSellProtectionContext {
  readonly productId: string | null;
  readonly clientOrderId: string | null;
  readonly requestedQuantity: number | null;
  readonly permissions: ControlPermissions;
  readonly snapshotId: string | null;
  readonly totalBaseQuantity: number | null;
  readonly availableBaseQuantity: number | null;
  readonly averageEntryPrice: number | null;
  readonly dustQuantity: number | null;
  readonly exchangeOrderId: string | null;
  readonly protectiveOrderId: string | null;
  readonly outcome: LiveSellProtectionOutcome;
  readonly lastError: WorkflowError | null;
}

// biome-ignore lint/suspicious/noEmptyInterface: entrée sans champ, contrainte structurelle volontaire
export interface LiveSellProtectionInput {}

export type LiveSellProtectionEvent =
  | {
      readonly type: "SELL_REQUESTED";
      readonly productId: string;
      readonly clientOrderId: string;
      readonly quantity: number;
      readonly permissions: ControlPermissions;
    }
  | { readonly type: "PROTECTIONS_CLEARED" }
  | {
      readonly type: "ACCOUNT_RECONCILED";
      readonly snapshotId: string;
      readonly totalBaseQuantity: number;
      readonly availableBaseQuantity: number;
      readonly averageEntryPrice: number;
      readonly dustQuantity: number;
    }
  | { readonly type: "SELL_ACKNOWLEDGED"; readonly exchangeOrderId: string }
  | { readonly type: "SELL_OUTCOME_UNKNOWN"; readonly exchangeOrderId: string | null }
  | { readonly type: "SELL_CONFIRMED"; readonly exchangeOrderId: string }
  | { readonly type: "SELL_REJECTED"; readonly error: WorkflowError }
  | {
      readonly type: "PROTECTION_ACKNOWLEDGED";
      readonly protectiveOrderId: string;
    }
  | { readonly type: "PROTECTION_CONFIRMED" }
  | { readonly type: "OPERATION_FAILED"; readonly error: WorkflowError }
  | { readonly type: "SAFETY_FLATTEN_SUCCEEDED" }
  | { readonly type: "SAFETY_FLATTEN_FAILED"; readonly error: WorkflowError };
