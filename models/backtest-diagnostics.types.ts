export type DiagnosticSignalSide = "BUY" | "SELL" | "HOLD";

export type RiskRejectionReasonCode =
  | "KILL_SWITCH_ACTIVE"
  | "DAILY_LOSS_LIMIT"
  | "COOLDOWN_ACTIVE"
  | "SPOT_SHORT_FORBIDDEN"
  | "ORDER_NOTIONAL_LIMIT"
  | "POSITION_NOTIONAL_LIMIT"
  | "GROSS_EXPOSURE_LIMIT";

export const RISK_REJECTION_REASON_CODES: readonly RiskRejectionReasonCode[] = [
  "KILL_SWITCH_ACTIVE",
  "DAILY_LOSS_LIMIT",
  "COOLDOWN_ACTIVE",
  "SPOT_SHORT_FORBIDDEN",
  "ORDER_NOTIONAL_LIMIT",
  "POSITION_NOTIONAL_LIMIT",
  "GROSS_EXPOSURE_LIMIT",
];

export interface SignalDiagnosticObservation {
  readonly strategyId: string;
  readonly side: DiagnosticSignalSide;
  readonly confidence: number;
  readonly suggestedSize: number;
  readonly referencePrice: number;
}

export interface AllocationDiagnosticObservation {
  readonly requestedNetNotional: number;
  readonly allocatedNotional: number;
  readonly riskApprovedNotional: number;
  readonly rejectedReasonCodes: readonly RiskRejectionReasonCode[];
}

export interface NumericDistribution {
  readonly count: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface StrategySignalDiagnostics {
  readonly strategyId: string;
  readonly evaluationCount: number;
  readonly activeSignalCount: number;
  readonly buySignalCount: number;
  readonly sellSignalCount: number;
  readonly activeSignalRate: number;
  readonly confidence: NumericDistribution;
  readonly requestedNotional: NumericDistribution;
}

export interface SignalDiagnostics {
  readonly byStrategy: readonly StrategySignalDiagnostics[];
}

export interface AllocationDiagnostics {
  readonly opportunityCount: number;
  readonly cappedCount: number;
  readonly capRate: number;
  readonly riskEvaluationCount: number;
  readonly riskRejectedCount: number;
  readonly riskRejectionRate: number;
  readonly riskRejectionReasons: Readonly<
    Record<RiskRejectionReasonCode, number>
  >;
  readonly requestedNetNotional: NumericDistribution;
  readonly allocatedNotional: NumericDistribution;
  readonly riskApprovedNotional: NumericDistribution;
}

export interface BacktestDiagnostics {
  readonly signals: SignalDiagnostics;
  readonly allocation: AllocationDiagnostics;
}

export interface StrategyRequestedNotionalSamples {
  readonly strategyId: string;
  readonly values: readonly number[];
}

export interface BacktestDiagnosticSamples {
  readonly requestedNotionalByStrategy: readonly StrategyRequestedNotionalSamples[];
}

export type BacktestDiagnosticsErrorCode =
  | "INVALID_SIGNAL_DIAGNOSTIC_OBSERVATION"
  | "INVALID_ALLOCATION_DIAGNOSTIC_OBSERVATION";

export interface BacktestDiagnosticsError {
  readonly code: BacktestDiagnosticsErrorCode;
}

export type BacktestDiagnosticsResult =
  | { readonly ok: true; readonly value: BacktestDiagnostics }
  | { readonly ok: false; readonly error: BacktestDiagnosticsError };

export type BacktestDiagnosticSamplesResult =
  | { readonly ok: true; readonly value: BacktestDiagnosticSamples }
  | { readonly ok: false; readonly error: BacktestDiagnosticsError };
