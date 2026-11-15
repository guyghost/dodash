export type LivePreflightFailureReason =
  | "LIVE_MUST_BE_DISABLED"
  | "CREDENTIALS_MISSING"
  | "TELEMETRY_MISSING"
  | "OPERATOR_NOTIFICATIONS_MISSING"
  | "KEY_PERMISSION_MISMATCH"
  | "PORTFOLIO_SCOPE_MISMATCH"
  | "PRODUCT_NOT_ALLOWED"
  | "ACCOUNT_RECONCILIATION_FAILED"
  | "ORDER_OWNERSHIP_DRIFT"
  | "PRODUCT_RULES_INVALID";

export interface LivePreflightEvidence {
  readonly liveTradingDisabled: boolean;
  readonly credentialsConfigured: boolean;
  readonly telemetryConfigured: boolean;
  readonly operatorNotificationsConfigured: boolean;
  readonly keyCanView: boolean;
  readonly keyCanTrade: boolean;
  readonly keyCanTransfer: boolean;
  readonly keyPortfolioMatches: boolean;
  readonly productAllowed: boolean;
  readonly accountReconciled: boolean;
  readonly allOpenOrdersOwned: boolean;
  readonly productRulesValid: boolean;
}

export type LivePreflightAssessment =
  | { readonly status: "APPROVED" }
  | {
      readonly status: "REJECTED";
      readonly reasonCode: LivePreflightFailureReason;
    };
