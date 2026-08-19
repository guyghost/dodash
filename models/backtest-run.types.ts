export interface BacktestPermissions {
  readonly canRunBacktest: boolean;
}

export type BacktestErrorCode =
  | "BACKTEST_PERMISSION_REQUIRED"
  | "HISTORICAL_DATA_UNAVAILABLE"
  | "INVALID_HISTORICAL_DATA"
  | "REPLAY_FAILED"
  | "METRICS_FAILED"
  | "CANCELLATION_FAILED";

export interface BacktestError {
  readonly code: BacktestErrorCode;
  readonly retryable: boolean;
}

export interface BacktestRunInput {
  readonly maxLoadRetries?: number;
}

export interface BacktestRunContext {
  readonly runId: string | null;
  readonly datasetId: string | null;
  readonly candleCount: number;
  readonly executionDatasetId: string | null;
  readonly executionCandleCount: number;
  readonly processedCandles: number;
  readonly tradesId: string | null;
  readonly tradeCount: number;
  readonly metricsId: string | null;
  readonly loadAttempts: number;
  readonly maxLoadRetries: number;
  readonly cancelRequested: boolean;
  readonly lastError: BacktestError | null;
}

export type BacktestRunEvent =
  | {
      readonly type: "START_REQUESTED";
      readonly runId: string;
      readonly permissions: BacktestPermissions;
    }
  | { readonly type: "CANCEL_REQUESTED" }
  | {
      readonly type: "HISTORICAL_DATA_READY";
      readonly datasetId: string;
      readonly candleCount: number;
      readonly executionDatasetId: string | null;
      readonly executionCandleCount: number;
    }
  | { readonly type: "HISTORICAL_DATA_FAILED"; readonly error: BacktestError }
  | { readonly type: "RETRY_TIMER_ELAPSED" }
  | {
      readonly type: "REPLAY_PROGRESS";
      readonly processedCandles: number;
    }
  | {
      readonly type: "REPLAY_COMPLETED";
      readonly tradesId: string;
      readonly tradeCount: number;
    }
  | { readonly type: "REPLAY_FAILED"; readonly error: BacktestError }
  | { readonly type: "METRICS_COMPUTED"; readonly metricsId: string }
  | { readonly type: "METRICS_FAILED"; readonly error: BacktestError }
  | { readonly type: "EFFECT_CANCELLED" }
  | { readonly type: "EFFECT_CANCEL_FAILED"; readonly error: BacktestError };
