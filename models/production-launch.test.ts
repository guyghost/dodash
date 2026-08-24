import { describe, expect, it } from "vitest";

import {
  assessCanaryEvidence,
  assessEngineeringEvidence,
  assessOperationsEvidence,
  assessResearchEvidence,
  assessRiskEvidence,
} from "./production-launch.js";
import type {
  CanaryEvidence,
  EngineeringEvidence,
  OperationsEvidence,
  ProductionLaunchScope,
  ResearchEvidence,
  RiskEvidence,
} from "./production-launch.types.js";

const scope: ProductionLaunchScope = {
  releaseSha: "a".repeat(40),
  policyId: "CONFIDENCE_POWER_THIRD_2026_08",
  productIds: ["GRT-USD", "MANA-USD", "XTZ-USD", "ZEC-USD"],
};

const researchEvidence = (): ResearchEvidence => ({
  releaseSha: scope.releaseSha,
  policyId: scope.policyId,
  productIds: scope.productIds,
  verdict: "VALIDATED",
  preRegistered: true,
  noPostHocExclusions: true,
  costs: {
    feesIncluded: true,
    spreadIncluded: true,
    slippageIncluded: true,
    executionLatencyIncluded: true,
  },
  products: scope.productIds.map((productId) => ({
    productId,
    cleanFoldCount: 4,
    profitableFoldCount: 3,
    medianNetReturn: 0.02,
    profitFactor: 1.2,
    expectedValuePerTrade: 1,
    maxDrawdown: 0.08,
    winRate: 0.45,
  })),
});

const riskEvidence = (): RiskEvidence => ({
  exchangeProtectionConfirmed: true,
  accountReconciledBeforeDecision: true,
  accountExposureAggregated: true,
  killCancelsOpenOrders: true,
  killFlattensManagedPosition: true,
  killReconcilesBeforeHalt: true,
  dailyLossLimitEffective: true,
  failuresCloseNewEntries: true,
  lifecycleTestsComplete: true,
});

const engineeringEvidence = (): EngineeringEvidence => ({
  releaseSha: scope.releaseSha,
  cleanCiPassed: true,
  unstableTestCount: 0,
  criticalVulnerabilityCount: 0,
  highVulnerabilityCount: 0,
  secretFindingCount: 0,
  branchProtected: true,
  requiredCiCheckConfigured: true,
  directPushBlocked: true,
  deploymentSha: scope.releaseSha,
  securityHeadersConfigured: true,
  authenticationRateLimitConfigured: true,
});

const operationsEvidence = (): OperationsEvidence => ({
  structuredTradingTelemetry: true,
  alertsConfigured: true,
  allHealthChecksPassed: true,
  incidentRunbookReady: true,
  onCallOwnerAssigned: true,
  rollbackVerified: true,
  deploysLiveDisabledFirst: true,
  singleProductRollout: true,
  rollbackThresholdsFrozen: true,
  productionSecretsVerified: true,
});

const canaryEvidence = (): CanaryEvidence => ({
  releaseSha: scope.releaseSha,
  policyId: scope.policyId,
  productId: "GRT-USD",
  shadowCalendarDays: 30,
  closedTradeCount: 30,
  rareSignalProtocol: false,
  unresolvedOrderCount: 0,
  duplicateOrderCount: 0,
  unreconciledPositionCount: 0,
  p95SlippageBps: 8,
  slippageBudgetBps: 10,
  maxDrawdown: 0.05,
  dailyLossBreachCount: 0,
  exposureBreachCount: 0,
  approvedLossBudget: true,
  humanObserverAvailable: true,
  killSwitchPreflightPassed: true,
  observationHours: 48,
  rollbackTriggerCount: 0,
});

describe("production launch assessors", () => {
  it("valide une preuve de recherche OOS complète sur les produits live exacts", () => {
    expect(assessResearchEvidence(scope, researchEvidence())).toEqual({
      ok: true,
    });
  });

  it("refuse une preuve de dimensionnement qui ne porte pas un verdict déployable", () => {
    expect(
      assessResearchEvidence(scope, {
        ...researchEvidence(),
        verdict: "RESEARCH_ONLY",
      }),
    ).toEqual({ ok: false, reasonCode: "RESEARCH_NOT_DEPLOYABLE" });
  });

  it("refuse un produit live qui échoue le transfert hors échantillon", () => {
    const evidence = researchEvidence();
    expect(
      assessResearchEvidence(scope, {
        ...evidence,
        products: evidence.products.map((product, index) =>
          index === 0 ? { ...product, profitableFoldCount: 2 } : product,
        ),
      }),
    ).toEqual({ ok: false, reasonCode: "RESEARCH_OOS_FAILED" });
  });

  it("refuse un modèle de coûts incomplet avant de lire l'alpha", () => {
    expect(
      assessResearchEvidence(scope, {
        ...researchEvidence(),
        costs: { ...researchEvidence().costs, spreadIncluded: false },
      }),
    ).toEqual({
      ok: false,
      reasonCode: "RESEARCH_COST_MODEL_INCOMPLETE",
    });
  });

  it("refuse le live sans protection exchange matérialisée", () => {
    expect(
      assessRiskEvidence({
        ...riskEvidence(),
        exchangeProtectionConfirmed: false,
      }),
    ).toEqual({ ok: false, reasonCode: "RISK_PROTECTION_MISSING" });
  });

  it("refuse un kill switch qui ne liquide pas la position gérée", () => {
    expect(
      assessRiskEvidence({
        ...riskEvidence(),
        killFlattensManagedPosition: false,
      }),
    ).toEqual({ ok: false, reasonCode: "RISK_KILL_NOT_FLATTENING" });
  });

  it("refuse une limite journalière inopérante", () => {
    expect(
      assessRiskEvidence({ ...riskEvidence(), dailyLossLimitEffective: false }),
    ).toEqual({ ok: false, reasonCode: "RISK_DAILY_LIMIT_INEFFECTIVE" });
  });

  it("refuse une CI verte localement mais instable sur le SHA de release", () => {
    expect(
      assessEngineeringEvidence(scope, {
        ...engineeringEvidence(),
        unstableTestCount: 1,
      }),
    ).toEqual({ ok: false, reasonCode: "ENGINEERING_TESTS_UNSTABLE" });
  });

  it("refuse toute vulnérabilité haute", () => {
    expect(
      assessEngineeringEvidence(scope, {
        ...engineeringEvidence(),
        highVulnerabilityCount: 1,
      }),
    ).toEqual({
      ok: false,
      reasonCode: "ENGINEERING_SECURITY_AUDIT_FAILED",
    });
  });

  it("refuse une branche non protégée", () => {
    expect(
      assessEngineeringEvidence(scope, {
        ...engineeringEvidence(),
        branchProtected: false,
      }),
    ).toEqual({ ok: false, reasonCode: "ENGINEERING_BRANCH_UNPROTECTED" });
  });

  it("refuse un rollback non vérifié", () => {
    expect(
      assessOperationsEvidence({
        ...operationsEvidence(),
        rollbackVerified: false,
      }),
    ).toEqual({ ok: false, reasonCode: "OPERATIONS_ROLLBACK_UNVERIFIED" });
  });

  it("accepte l'alternative préenregistrée de 90 jours pour un signal rare", () => {
    expect(
      assessCanaryEvidence(scope, {
        ...canaryEvidence(),
        shadowCalendarDays: 90,
        closedTradeCount: 12,
        rareSignalProtocol: true,
      }),
    ).toEqual({ ok: true });
  });

  it("refuse un canary avec ordre non résolu", () => {
    expect(
      assessCanaryEvidence(scope, {
        ...canaryEvidence(),
        unresolvedOrderCount: 1,
      }),
    ).toEqual({
      ok: false,
      reasonCode: "CANARY_EXECUTION_INTEGRITY_FAILED",
    });
  });
});

export const validProductionLaunchEvidence = {
  scope,
  researchEvidence,
  riskEvidence,
  engineeringEvidence,
  operationsEvidence,
  canaryEvidence,
};
