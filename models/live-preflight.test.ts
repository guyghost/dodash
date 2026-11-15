import { describe, expect, it } from "vitest";

import { assessLivePreflight } from "./live-preflight.js";
import type { LivePreflightEvidence } from "./live-preflight.types.js";

const valid = (): LivePreflightEvidence => ({
  liveTradingDisabled: true,
  credentialsConfigured: true,
  telemetryConfigured: true,
  operatorNotificationsConfigured: true,
  keyCanView: true,
  keyCanTrade: true,
  keyCanTransfer: false,
  keyPortfolioMatches: true,
  productAllowed: true,
  accountReconciled: true,
  allOpenOrdersOwned: true,
  productRulesValid: true,
});

describe("assessLivePreflight", () => {
  it("approuve uniquement le préflight read-only complet", () => {
    expect(assessLivePreflight(valid())).toEqual({ status: "APPROVED" });
  });

  it.each([
    ["liveTradingDisabled", false, "LIVE_MUST_BE_DISABLED"],
    ["credentialsConfigured", false, "CREDENTIALS_MISSING"],
    ["telemetryConfigured", false, "TELEMETRY_MISSING"],
    ["operatorNotificationsConfigured", false, "OPERATOR_NOTIFICATIONS_MISSING"],
    ["keyCanView", false, "KEY_PERMISSION_MISMATCH"],
    ["keyCanTrade", false, "KEY_PERMISSION_MISMATCH"],
    ["keyCanTransfer", true, "KEY_PERMISSION_MISMATCH"],
    ["keyPortfolioMatches", false, "PORTFOLIO_SCOPE_MISMATCH"],
    ["productAllowed", false, "PRODUCT_NOT_ALLOWED"],
    ["accountReconciled", false, "ACCOUNT_RECONCILIATION_FAILED"],
    ["allOpenOrdersOwned", false, "ORDER_OWNERSHIP_DRIFT"],
    ["productRulesValid", false, "PRODUCT_RULES_INVALID"],
  ] as const)("refuse %s=%s", (field, value, reasonCode) => {
    expect(assessLivePreflight({ ...valid(), [field]: value })).toEqual({
      status: "REJECTED",
      reasonCode,
    });
  });
});
