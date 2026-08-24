import type {
  CanaryEvidence,
  CanaryFailureReason,
  EngineeringEvidence,
  EngineeringFailureReason,
  OperationsEvidence,
  OperationsFailureReason,
  ProductionLaunchAssessment,
  ProductionLaunchScope,
  ResearchEvidence,
  ResearchFailureReason,
  ResearchProductEvidence,
  RiskEvidence,
  RiskFailureReason,
} from "./production-launch.types.js";
import {
  LIVE_TRADING_POLICY_ID,
  LIVE_TRADING_PRODUCTS,
} from "./live-trading-policy.js";

const accepted = Object.freeze({ ok: true as const });
const rejected = <Reason extends string>(reasonCode: Reason) =>
  Object.freeze({ ok: false as const, reasonCode });

const sameUniqueStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    [...leftSet].every((value) => rightSet.has(value))
  );
};

const isNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const isFiniteRate = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const validResearchProduct = (product: ResearchProductEvidence): boolean =>
  product.productId.length > 0 &&
  isNonNegativeInteger(product.cleanFoldCount) &&
  isNonNegativeInteger(product.profitableFoldCount) &&
  product.profitableFoldCount <= product.cleanFoldCount &&
  Number.isFinite(product.medianNetReturn) &&
  Number.isFinite(product.profitFactor) &&
  product.profitFactor >= 0 &&
  Number.isFinite(product.expectedValuePerTrade) &&
  isFiniteRate(product.maxDrawdown) &&
  isFiniteRate(product.winRate);

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const OPERATIONS_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export const assessProductionLaunchScope = (
  scope: ProductionLaunchScope,
): ProductionLaunchAssessment<ResearchFailureReason> =>
  RELEASE_SHA_PATTERN.test(scope.releaseSha) &&
  scope.policyId === LIVE_TRADING_POLICY_ID &&
  sameUniqueStrings(scope.productIds, LIVE_TRADING_PRODUCTS) &&
  Number.isSafeInteger(scope.evaluatedAt) &&
  scope.evaluatedAt > 0
    ? accepted
    : rejected("RESEARCH_SCOPE_MISMATCH");

export const assessResearchEvidence = (
  scope: ProductionLaunchScope,
  evidence: ResearchEvidence,
): ProductionLaunchAssessment<ResearchFailureReason> => {
  const scopeAssessment = assessProductionLaunchScope(scope);
  if (!scopeAssessment.ok) return scopeAssessment;
  if (
    evidence.releaseSha !== scope.releaseSha ||
    evidence.policyId !== scope.policyId ||
    !sameUniqueStrings(evidence.productIds, scope.productIds) ||
    !sameUniqueStrings(
      evidence.products.map(({ productId }) => productId),
      scope.productIds,
    )
  ) {
    return rejected("RESEARCH_SCOPE_MISMATCH");
  }
  if (evidence.verdict !== "VALIDATED") {
    return rejected("RESEARCH_NOT_DEPLOYABLE");
  }
  if (
    !evidence.preRegistered ||
    !evidence.noPostHocExclusions ||
    evidence.products.some((product) => !validResearchProduct(product))
  ) {
    return rejected("RESEARCH_EVIDENCE_INCOMPLETE");
  }
  if (
    !evidence.costs.feesIncluded ||
    !evidence.costs.spreadIncluded ||
    !evidence.costs.slippageIncluded ||
    !evidence.costs.executionLatencyIncluded
  ) {
    return rejected("RESEARCH_COST_MODEL_INCOMPLETE");
  }
  if (
    evidence.products.some(
      (product) =>
        product.cleanFoldCount < 4 ||
        product.profitableFoldCount < 3 ||
        product.medianNetReturn <= 0 ||
        product.profitFactor <= 1 ||
        product.expectedValuePerTrade <= 0 ||
        product.maxDrawdown > 0.1,
    )
  ) {
    return rejected("RESEARCH_OOS_FAILED");
  }
  return accepted;
};

export const assessRiskEvidence = (
  evidence: RiskEvidence,
): ProductionLaunchAssessment<RiskFailureReason> => {
  if (!evidence.exchangeProtectionConfirmed) {
    return rejected("RISK_PROTECTION_MISSING");
  }
  if (
    !evidence.accountReconciledBeforeDecision ||
    !evidence.accountExposureAggregated
  ) {
    return rejected("RISK_ACCOUNT_NOT_RECONCILED");
  }
  if (
    !evidence.killCancelsOpenOrders ||
    !evidence.killFlattensManagedPosition ||
    !evidence.killReconcilesBeforeHalt
  ) {
    return rejected("RISK_KILL_NOT_FLATTENING");
  }
  if (!evidence.dailyLossLimitEffective) {
    return rejected("RISK_DAILY_LIMIT_INEFFECTIVE");
  }
  if (!evidence.failuresCloseNewEntries) {
    return rejected("RISK_FAILURE_NOT_CLOSED");
  }
  return evidence.lifecycleTestsComplete
    ? accepted
    : rejected("RISK_TEST_COVERAGE_INCOMPLETE");
};

export const assessEngineeringEvidence = (
  scope: ProductionLaunchScope,
  evidence: EngineeringEvidence,
): ProductionLaunchAssessment<EngineeringFailureReason> => {
  if (
    evidence.releaseSha !== scope.releaseSha ||
    evidence.deploymentSha !== scope.releaseSha
  ) {
    return rejected("ENGINEERING_RELEASE_SHA_MISMATCH");
  }
  if (!evidence.cleanCiPassed) {
    return rejected("ENGINEERING_CI_NOT_GREEN");
  }
  if (
    !isNonNegativeInteger(evidence.unstableTestCount) ||
    evidence.unstableTestCount > 0
  ) {
    return rejected("ENGINEERING_TESTS_UNSTABLE");
  }
  if (
    !isNonNegativeInteger(evidence.criticalVulnerabilityCount) ||
    !isNonNegativeInteger(evidence.highVulnerabilityCount) ||
    evidence.criticalVulnerabilityCount > 0 ||
    evidence.highVulnerabilityCount > 0
  ) {
    return rejected("ENGINEERING_SECURITY_AUDIT_FAILED");
  }
  if (
    !isNonNegativeInteger(evidence.secretFindingCount) ||
    evidence.secretFindingCount > 0
  ) {
    return rejected("ENGINEERING_SECRET_SCAN_FAILED");
  }
  if (
    !evidence.branchProtected ||
    !evidence.requiredCiCheckConfigured ||
    !evidence.directPushBlocked
  ) {
    return rejected("ENGINEERING_BRANCH_UNPROTECTED");
  }
  if (
    !evidence.securityHeadersConfigured ||
    !evidence.authenticationRateLimitConfigured
  ) {
    return rejected("ENGINEERING_EDGE_HARDENING_MISSING");
  }
  return accepted;
};

export const assessOperationsEvidence = (
  scope: ProductionLaunchScope,
  evidence: OperationsEvidence,
): ProductionLaunchAssessment<OperationsFailureReason> => {
  if (
    !assessProductionLaunchScope(scope).ok ||
    evidence.releaseSha !== scope.releaseSha ||
    evidence.deploymentSha !== scope.releaseSha
  ) {
    return rejected("OPERATIONS_SCOPE_MISMATCH");
  }
  if (
    !Number.isSafeInteger(evidence.collectedAt) ||
    evidence.collectedAt <= 0 ||
    evidence.collectedAt > scope.evaluatedAt ||
    scope.evaluatedAt - evidence.collectedAt > OPERATIONS_EVIDENCE_MAX_AGE_MS
  ) {
    return rejected("OPERATIONS_EVIDENCE_STALE");
  }
  if (!evidence.structuredTradingTelemetry) {
    return rejected("OPERATIONS_OBSERVABILITY_MISSING");
  }
  if (!evidence.alertsConfigured) {
    return rejected("OPERATIONS_ALERTING_MISSING");
  }
  if (!evidence.allHealthChecksPassed) {
    return rejected("OPERATIONS_HEALTHCHECK_FAILED");
  }
  if (!evidence.incidentRunbookReady || !evidence.onCallOwnerAssigned) {
    return rejected("OPERATIONS_RUNBOOK_MISSING");
  }
  if (!evidence.rollbackVerified) {
    return rejected("OPERATIONS_ROLLBACK_UNVERIFIED");
  }
  if (
    !evidence.deploysLiveDisabledFirst ||
    !evidence.singleProductRollout ||
    !evidence.rollbackThresholdsFrozen
  ) {
    return rejected("OPERATIONS_ROLLOUT_UNSAFE");
  }
  return evidence.productionSecretsVerified
    ? accepted
    : rejected("OPERATIONS_SECRETS_UNVERIFIED");
};

export const assessCanaryEvidence = (
  scope: ProductionLaunchScope,
  evidence: CanaryEvidence,
): ProductionLaunchAssessment<CanaryFailureReason> => {
  if (
    evidence.releaseSha !== scope.releaseSha ||
    evidence.policyId !== scope.policyId ||
    !scope.productIds.includes(evidence.productId)
  ) {
    return rejected("CANARY_SCOPE_MISMATCH");
  }
  if (
    !isNonNegativeInteger(evidence.shadowCalendarDays) ||
    evidence.shadowCalendarDays < 30
  ) {
    return rejected("CANARY_SHADOW_INSUFFICIENT");
  }
  if (
    !isNonNegativeInteger(evidence.closedTradeCount) ||
    (evidence.closedTradeCount < 30 &&
      (!evidence.rareSignalProtocol || evidence.shadowCalendarDays < 90))
  ) {
    return rejected("CANARY_SAMPLE_INSUFFICIENT");
  }
  if (
    !isNonNegativeInteger(evidence.unresolvedOrderCount) ||
    !isNonNegativeInteger(evidence.duplicateOrderCount) ||
    !isNonNegativeInteger(evidence.unreconciledPositionCount) ||
    evidence.unresolvedOrderCount > 0 ||
    evidence.duplicateOrderCount > 0 ||
    evidence.unreconciledPositionCount > 0
  ) {
    return rejected("CANARY_EXECUTION_INTEGRITY_FAILED");
  }
  if (
    !Number.isFinite(evidence.p95SlippageBps) ||
    !Number.isFinite(evidence.slippageBudgetBps) ||
    evidence.p95SlippageBps < 0 ||
    evidence.slippageBudgetBps < 0 ||
    evidence.p95SlippageBps > evidence.slippageBudgetBps
  ) {
    return rejected("CANARY_SLIPPAGE_FAILED");
  }
  if (
    !isFiniteRate(evidence.maxDrawdown) ||
    evidence.maxDrawdown > 0.1 ||
    !isNonNegativeInteger(evidence.dailyLossBreachCount) ||
    !isNonNegativeInteger(evidence.exposureBreachCount) ||
    evidence.dailyLossBreachCount > 0 ||
    evidence.exposureBreachCount > 0
  ) {
    return rejected("CANARY_RISK_LIMIT_BREACHED");
  }
  if (
    !evidence.approvedLossBudget ||
    !evidence.humanObserverAvailable ||
    !evidence.killSwitchPreflightPassed
  ) {
    return rejected("CANARY_CONTROL_UNAVAILABLE");
  }
  if (
    !Number.isFinite(evidence.observationHours) ||
    evidence.observationHours < 48 ||
    !isNonNegativeInteger(evidence.rollbackTriggerCount) ||
    evidence.rollbackTriggerCount > 0
  ) {
    return rejected("CANARY_OBSERVATION_INCOMPLETE");
  }
  return accepted;
};
