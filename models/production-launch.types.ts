export type ProductionLaunchStage =
  | "research"
  | "risk"
  | "engineering"
  | "operations"
  | "canary";

export type ResearchFailureReason =
  | "RESEARCH_SCOPE_MISMATCH"
  | "RESEARCH_EVIDENCE_INCOMPLETE"
  | "RESEARCH_OOS_FAILED"
  | "RESEARCH_COST_MODEL_INCOMPLETE"
  | "RESEARCH_NOT_DEPLOYABLE";

export type RiskFailureReason =
  | "RISK_PROTECTION_MISSING"
  | "RISK_ACCOUNT_NOT_RECONCILED"
  | "RISK_KILL_NOT_FLATTENING"
  | "RISK_DAILY_LIMIT_INEFFECTIVE"
  | "RISK_FAILURE_NOT_CLOSED"
  | "RISK_TEST_COVERAGE_INCOMPLETE";

export type EngineeringFailureReason =
  | "ENGINEERING_CI_NOT_GREEN"
  | "ENGINEERING_TESTS_UNSTABLE"
  | "ENGINEERING_SECURITY_AUDIT_FAILED"
  | "ENGINEERING_SECRET_SCAN_FAILED"
  | "ENGINEERING_BRANCH_UNPROTECTED"
  | "ENGINEERING_RELEASE_SHA_MISMATCH"
  | "ENGINEERING_EDGE_HARDENING_MISSING";

export type OperationsFailureReason =
  | "OPERATIONS_OBSERVABILITY_MISSING"
  | "OPERATIONS_ALERTING_MISSING"
  | "OPERATIONS_HEALTHCHECK_FAILED"
  | "OPERATIONS_RUNBOOK_MISSING"
  | "OPERATIONS_ROLLBACK_UNVERIFIED"
  | "OPERATIONS_ROLLOUT_UNSAFE"
  | "OPERATIONS_SECRETS_UNVERIFIED";

export type CanaryFailureReason =
  | "CANARY_SCOPE_MISMATCH"
  | "CANARY_SHADOW_INSUFFICIENT"
  | "CANARY_SAMPLE_INSUFFICIENT"
  | "CANARY_EXECUTION_INTEGRITY_FAILED"
  | "CANARY_SLIPPAGE_FAILED"
  | "CANARY_RISK_LIMIT_BREACHED"
  | "CANARY_CONTROL_UNAVAILABLE"
  | "CANARY_OBSERVATION_INCOMPLETE";

export type ProductionLaunchFailureReason =
  | ResearchFailureReason
  | RiskFailureReason
  | EngineeringFailureReason
  | OperationsFailureReason
  | CanaryFailureReason;

export type ProductionLaunchAssessment<
  Reason extends ProductionLaunchFailureReason,
> = { readonly ok: true } | { readonly ok: false; readonly reasonCode: Reason };

export interface ProductionLaunchScope {
  readonly releaseSha: string;
  readonly policyId: string;
  readonly productIds: readonly string[];
}

export interface ResearchProductEvidence {
  readonly productId: string;
  readonly cleanFoldCount: number;
  readonly profitableFoldCount: number;
  readonly medianNetReturn: number;
  readonly profitFactor: number;
  readonly expectedValuePerTrade: number;
  readonly maxDrawdown: number;
  readonly winRate: number;
}

export interface ResearchEvidence {
  readonly releaseSha: string;
  readonly policyId: string;
  readonly productIds: readonly string[];
  readonly verdict: "VALIDATED" | "RESEARCH_ONLY" | "DECLASSIFIED";
  readonly preRegistered: boolean;
  readonly noPostHocExclusions: boolean;
  readonly costs: {
    readonly feesIncluded: boolean;
    readonly spreadIncluded: boolean;
    readonly slippageIncluded: boolean;
    readonly executionLatencyIncluded: boolean;
  };
  readonly products: readonly ResearchProductEvidence[];
}

export interface RiskEvidence {
  readonly exchangeProtectionConfirmed: boolean;
  readonly accountReconciledBeforeDecision: boolean;
  readonly accountExposureAggregated: boolean;
  readonly killCancelsOpenOrders: boolean;
  readonly killFlattensManagedPosition: boolean;
  readonly killReconcilesBeforeHalt: boolean;
  readonly dailyLossLimitEffective: boolean;
  readonly failuresCloseNewEntries: boolean;
  readonly lifecycleTestsComplete: boolean;
}

export interface EngineeringEvidence {
  readonly releaseSha: string;
  readonly cleanCiPassed: boolean;
  readonly unstableTestCount: number;
  readonly criticalVulnerabilityCount: number;
  readonly highVulnerabilityCount: number;
  readonly secretFindingCount: number;
  readonly branchProtected: boolean;
  readonly requiredCiCheckConfigured: boolean;
  readonly directPushBlocked: boolean;
  readonly deploymentSha: string;
  readonly securityHeadersConfigured: boolean;
  readonly authenticationRateLimitConfigured: boolean;
}

export interface OperationsEvidence {
  readonly structuredTradingTelemetry: boolean;
  readonly alertsConfigured: boolean;
  readonly allHealthChecksPassed: boolean;
  readonly incidentRunbookReady: boolean;
  readonly onCallOwnerAssigned: boolean;
  readonly rollbackVerified: boolean;
  readonly deploysLiveDisabledFirst: boolean;
  readonly singleProductRollout: boolean;
  readonly rollbackThresholdsFrozen: boolean;
  readonly productionSecretsVerified: boolean;
}

export interface CanaryEvidence {
  readonly releaseSha: string;
  readonly policyId: string;
  readonly productId: string;
  readonly shadowCalendarDays: number;
  readonly closedTradeCount: number;
  readonly rareSignalProtocol: boolean;
  readonly unresolvedOrderCount: number;
  readonly duplicateOrderCount: number;
  readonly unreconciledPositionCount: number;
  readonly p95SlippageBps: number;
  readonly slippageBudgetBps: number;
  readonly maxDrawdown: number;
  readonly dailyLossBreachCount: number;
  readonly exposureBreachCount: number;
  readonly approvedLossBudget: boolean;
  readonly humanObserverAvailable: boolean;
  readonly killSwitchPreflightPassed: boolean;
  readonly observationHours: number;
  readonly rollbackTriggerCount: number;
}

export interface ProductionLaunchContext extends ProductionLaunchScope {
  readonly passedStages: readonly ProductionLaunchStage[];
  readonly failedStage: ProductionLaunchStage | null;
  readonly reasonCode: ProductionLaunchFailureReason | null;
}

export type ProductionLaunchEvent =
  | { readonly type: "LAUNCH_REQUESTED" }
  | {
      readonly type: "RESEARCH_EVIDENCE_SUBMITTED";
      readonly evidence: ResearchEvidence;
    }
  | {
      readonly type: "RISK_EVIDENCE_SUBMITTED";
      readonly evidence: RiskEvidence;
    }
  | {
      readonly type: "ENGINEERING_EVIDENCE_SUBMITTED";
      readonly evidence: EngineeringEvidence;
    }
  | {
      readonly type: "OPERATIONS_EVIDENCE_SUBMITTED";
      readonly evidence: OperationsEvidence;
    }
  | {
      readonly type: "CANARY_EVIDENCE_SUBMITTED";
      readonly evidence: CanaryEvidence;
    }
  | { readonly type: "CANCEL_REQUESTED" }
  | { readonly type: "RETRY_REQUESTED" }
  | { readonly type: "RESET" };
