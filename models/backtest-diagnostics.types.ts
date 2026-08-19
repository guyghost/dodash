export type DiagnosticSignalSide = "BUY" | "SELL" | "HOLD";

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
  readonly requestedNetNotional: NumericDistribution;
  readonly allocatedNotional: NumericDistribution;
  readonly riskApprovedNotional: NumericDistribution;
}

export interface BacktestDiagnostics {
  readonly signals: SignalDiagnostics;
  readonly allocation: AllocationDiagnostics;
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
