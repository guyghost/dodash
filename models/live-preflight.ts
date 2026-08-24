import type {
  LivePreflightAssessment,
  LivePreflightEvidence,
  LivePreflightFailureReason,
} from "./live-preflight.types.js";

const rejected = (
  reasonCode: LivePreflightFailureReason,
): LivePreflightAssessment => ({ status: "REJECTED", reasonCode });

export const assessLivePreflight = (
  evidence: LivePreflightEvidence,
): LivePreflightAssessment => {
  if (!evidence.liveTradingDisabled) return rejected("LIVE_MUST_BE_DISABLED");
  if (!evidence.credentialsConfigured) return rejected("CREDENTIALS_MISSING");
  if (!evidence.telemetryConfigured) return rejected("TELEMETRY_MISSING");
  if (
    !evidence.keyCanView ||
    !evidence.keyCanTrade ||
    evidence.keyCanTransfer
  ) {
    return rejected("KEY_PERMISSION_MISMATCH");
  }
  if (!evidence.keyPortfolioMatches) {
    return rejected("PORTFOLIO_SCOPE_MISMATCH");
  }
  if (!evidence.productAllowed) return rejected("PRODUCT_NOT_ALLOWED");
  if (!evidence.accountReconciled) {
    return rejected("ACCOUNT_RECONCILIATION_FAILED");
  }
  if (!evidence.allOpenOrdersOwned) {
    return rejected("ORDER_OWNERSHIP_DRIFT");
  }
  return evidence.productRulesValid
    ? { status: "APPROVED" }
    : rejected("PRODUCT_RULES_INVALID");
};
