export { backtestRunMachine } from "./backtest-run.machine.js";
export {
  assessConfidenceCalibrationConfirmation,
  CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES,
} from "./confidence-calibration-confirmation.js";
export type {
  ConfidenceCalibrationConfirmationAssessment,
  ConfidenceCalibrationConfirmationFailureReason,
  ConfidenceCalibrationConfirmationObservation,
  ConfidenceCalibrationConfirmationProfile,
  ConfidenceCalibrationConfirmationResult,
  ConfidenceCalibrationConfirmationRunInvariant,
} from "./confidence-calibration-confirmation.js";
export {
  assessConfidenceCalibrationTailConfirmation,
  CONFIDENCE_CALIBRATION_TAIL_POLICY,
} from "./confidence-calibration-tail-confirmation.js";
export {
  assessConfidenceQuantileSensitivity,
  CONFIDENCE_QUANTILE_ESTIMATORS,
  CONFIDENCE_QUANTILE_SENSITIVITY_POLICY,
  estimateQuantile,
} from "./confidence-quantile-sensitivity.js";
export {
  assessConfidenceQuantileSampleSizeAudit,
  assessLessCorrelatedReplicationSources,
  classifyConfidenceQuantileRankResolution,
  CONFIDENCE_QUANTILE_DISCRETE_ESTIMATORS,
  CONFIDENCE_QUANTILE_RANK_RESOLUTIONS,
  CONFIDENCE_QUANTILE_SAMPLE_SIZE_EXPECTED_RUN_KEYS,
  CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS,
} from "./confidence-quantile-sample-size.js";
export type {
  ConfidenceQuantileDiscreteEstimator,
  ConfidenceQuantileRankPosition,
  ConfidenceQuantileRankResolution,
  ConfidenceQuantileSampleSizeAssessment,
  ConfidenceQuantileSampleSizeCase,
  ConfidenceQuantileSampleSizeObservation,
  ConfidenceQuantileSampleSizePopulation,
  ConfidenceQuantileSampleSizeProtocolEvidence,
  ConfidenceQuantileSampleSizeResult,
  ConfidenceQuantileSampleSizeSummary,
  LessCorrelatedAssetUniverse,
  LessCorrelatedReplicationSource,
  LessCorrelatedReplicationSourceAssessment,
  LessCorrelatedReplicationSourceResult,
} from "./confidence-quantile-sample-size.js";
export type {
  ConfidenceQuantileEstimator,
  ConfidenceQuantileEstimatorAssessment,
  ConfidenceQuantileSensitivityAssessment,
  ConfidenceQuantileSensitivityFailureReason,
  ConfidenceQuantileSensitivityObservation,
  ConfidenceQuantileSensitivityResult,
  QuantileEstimateResult,
} from "./confidence-quantile-sensitivity.js";
export type {
  ConfidenceCalibrationTailConfirmationAssessment,
  ConfidenceCalibrationTailConfirmationFailureReason,
  ConfidenceCalibrationTailConfirmationResult,
} from "./confidence-calibration-tail-confirmation.js";
export {
  calibrateConfidence,
  CONFIDENCE_CALIBRATION_PROFILES,
  isConfidenceCalibrationProfile,
  selectConfidenceCalibrationProfile,
} from "./confidence-calibration.js";
export type {
  CalibratedStrategyId,
  ConfidenceCalibrationCandidateSummary,
  ConfidenceCalibrationDevelopmentObservation,
  ConfidenceCalibrationErrorCode,
  ConfidenceCalibrationIneligibilityReason,
  ConfidenceCalibrationProfile,
  ConfidenceCalibrationResult,
  ConfidenceCalibrationSelection,
  ConfidenceCalibrationSelectionResult,
} from "./confidence-calibration.js";
export {
  extractBacktestDiagnosticSamples,
  summarizeBacktestDiagnostics,
} from "./backtest-diagnostics.js";
export type {
  AllocationDiagnosticObservation,
  AllocationDiagnostics,
  BacktestDiagnosticSamples,
  BacktestDiagnosticSamplesResult,
  BacktestDiagnostics,
  BacktestDiagnosticsError,
  BacktestDiagnosticsErrorCode,
  BacktestDiagnosticsResult,
  DiagnosticSignalSide,
  NumericDistribution,
  SignalDiagnosticObservation,
  SignalDiagnostics,
  StrategySignalDiagnostics,
  StrategyRequestedNotionalSamples,
} from "./backtest-diagnostics.types.js";
export type {
  BacktestError,
  BacktestErrorCode,
  BacktestPermissions,
  BacktestRunContext,
  BacktestRunEvent,
  BacktestRunInput,
} from "./backtest-run.types.js";
export { dashboardSessionMachine } from "./dashboard-session.machine.js";
export { resolveDailyRiskWindow } from "./daily-risk.js";
export type {
  DailyRiskAssessment,
  DailyRiskWindow,
} from "./daily-risk.js";
export { DASHBOARD_REMOTE_PHASES } from "./dashboard-session.types.js";
export type {
  DashboardCommand,
  DashboardDirectCommand,
  DashboardError,
  DashboardErrorCode,
  DashboardPermissions,
  DashboardRemotePhase,
  DashboardSessionContext,
  DashboardSessionEvent,
  DashboardSessionInput,
} from "./dashboard-session.types.js";
export {
  createExecutionSchedule,
  resolveRiskEvaluationTimestamp,
} from "./execution-resolution.js";
export type {
  ExecutionCandle,
  ExecutionSchedule,
  ExecutionScheduleBucket,
  ExecutionScheduleError,
  ExecutionScheduleErrorCode,
  ExecutionScheduleResult,
} from "./execution-resolution.types.js";
export { protectiveOrderMachine } from "./protective-order.machine.js";
export { qualityGateMachine } from "./quality-gate.machine.js";
export type {
  QualityGateContext,
  QualityGateError,
  QualityGateErrorCode,
  QualityGateEvent,
  QualityGateSource,
  QualityGateStage,
} from "./quality-gate.types.js";
export {
  createProtectiveOrderPlan,
  isValidProtectiveExitPolicy,
  resolveProtectiveOpen,
  resolveProtectiveRange,
  summarizeProtectiveExits,
} from "./protective-order.js";
export type {
  ActiveProtectiveExitPolicy,
  CreateProtectiveOrderPlanInput,
  ProtectiveCancelReason,
  ProtectiveExitKind,
  ProtectiveExitCounts,
  ProtectiveExitPolicy,
  ProtectiveExitReason,
  ProtectiveExitResolution,
  ProtectiveExitSummaryInput,
  ProtectiveNoTrigger,
  ProtectiveOpen,
  ProtectiveOrderContext,
  ProtectiveOrderError,
  ProtectiveOrderErrorCode,
  ProtectiveOrderEvent,
  ProtectiveOrderInput,
  ProtectiveOrderPlan,
  ProtectiveRange,
  ProtectiveResolution,
  ProtectiveResult,
} from "./protective-order.types.js";
export { resolveTargetSignalQuantity } from "./signal-sizing.js";
export type {
  SignalSizingError,
  SignalSizingErrorCode,
  SignalSizingResult,
} from "./signal-sizing.types.js";
export { regimeFilterMachine } from "./regime-filter.machine.js";
export {
  classifyRegimeObservation,
  DEFAULT_REGIME_PERMISSIONS,
  isValidRegimeFilterPolicy,
  isValidRegimeObservation,
  resolveRegimePermission,
} from "./regime-filter.js";
export type {
  EmaSlopeRegimePolicy,
  EmaThresholdRegimePolicy,
  RegimeFilterContext,
  RegimeFilterError,
  RegimeFilterErrorCode,
  RegimeFilterEvent,
  RegimeFilterInput,
  RegimeFilterPolicy,
  RegimeFilterStopReason,
  RegimeKind,
  RegimeObservation,
  RegimePermissions,
  RegimePermissionsResult,
} from "./regime-filter.types.js";
export { tradingCycleMachine } from "./trading-cycle.machine.js";
export {
  assessLiveTradingAgentIdentity,
  assessLiveTradingPolicy,
  liveTradingAgentName,
  LIVE_TRADING_POLICY,
  LIVE_TRADING_POLICY_ID,
  LIVE_TRADING_PRODUCTS,
} from "./live-trading-policy.js";
export type {
  LiveTradingAdmission,
  LiveTradingCandidate,
  LiveTradingIdentityAdmission,
  LiveTradingProduct,
  LiveTradingRiskPolicy,
  LiveTradingSizingPolicy,
} from "./live-trading-policy.js";
export type {
  ControlPermissions,
  CycleOutcome,
  RetryAttempts,
  RetryLimits,
  ShutdownMode,
  TradingCycleContext,
  TradingCycleEvent,
  TradingCycleInput,
  WorkflowError,
  WorkflowErrorCode,
  WorkflowPhase,
} from "./trading-cycle.types.js";
