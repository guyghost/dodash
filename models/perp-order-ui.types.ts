import type {
  HyperliquidOrderOutcome,
  HyperliquidPerpProduct,
  PerpRefusalCode,
} from "./hyperliquid-execution.types.js";

export interface PerpOrderFormDraft {
  readonly productId: HyperliquidPerpProduct;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly markPrice: number;
  readonly leverage: number;
  readonly dailyPnl: number;
}

export interface PerpOrderUiPermissions {
  readonly canControl: boolean;
  readonly canTrade: boolean;
}

export type PerpOrderUiErrorCode =
  | "PERP_DRAFT_PRODUCT"
  | "PERP_DRAFT_SIDE"
  | "PERP_DRAFT_QUANTITY"
  | "PERP_DRAFT_PRICE"
  | "PERP_DRAFT_LEVERAGE"
  | "PERP_DRAFT_DAILY_PNL"
  | "PERP_PERMISSIONS_REQUIRED";

export type PerpOrderUiResult =
  | {
      readonly status: "SETTLED";
      readonly outcome: HyperliquidOrderOutcome;
      readonly clientOrderId: string;
    }
  | { readonly status: "REFUSED"; readonly reasonCode: PerpRefusalCode }
  | { readonly status: "FAILED"; readonly errorCode: string };

export interface PerpOrderUiTransportError {
  readonly code: "REQUEST_FAILED";
  readonly retryable: boolean;
}

export interface PerpOrderUiContext {
  readonly draft: PerpOrderFormDraft | null;
  readonly clientOrderId: string | null;
  readonly result: PerpOrderUiResult | null;
  readonly lastRefusal: PerpOrderUiErrorCode | null;
  readonly lastError: PerpOrderUiTransportError | null;
}

export type PerpOrderUiEvent =
  | {
      readonly type: "SUBMISSION_PREPARED";
      readonly draft: PerpOrderFormDraft;
      readonly permissions: PerpOrderUiPermissions;
    }
  | {
      readonly type: "PERP_ORDER_CONFIRMED";
      readonly permissions: PerpOrderUiPermissions;
      readonly clientOrderId: string;
    }
  | { readonly type: "PERP_ORDER_CANCELLED" }
  | { readonly type: "SUBMISSION_SUCCEEDED"; readonly result: PerpOrderUiResult }
  | {
      readonly type: "SUBMISSION_FAILED";
      readonly error: PerpOrderUiTransportError;
    }
  | { readonly type: "SUBMISSION_DISMISSED" }
  | { readonly type: "PERP_ORDER_FORM_RESET" };

/** Réservé à la machine ; la génération d'identifiants vit dans le shell. */
export type PerpOrderUiInput = Record<string, never>;
