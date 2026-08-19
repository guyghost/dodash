export interface ExecutionCandle {
  readonly start: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ExecutionScheduleBucket {
  readonly primaryCandle: ExecutionCandle;
  readonly executionCandles: readonly ExecutionCandle[];
}

export interface ExecutionSchedule {
  readonly resolutionRatio: number;
  readonly buckets: readonly ExecutionScheduleBucket[];
}

export type ExecutionScheduleErrorCode =
  | "EMPTY_PRIMARY_SERIES"
  | "INSUFFICIENT_PRIMARY_CANDLES"
  | "INSUFFICIENT_EXECUTION_CANDLES"
  | "NON_UNIFORM_PRIMARY_INTERVAL"
  | "NON_UNIFORM_EXECUTION_INTERVAL"
  | "INVALID_EXECUTION_RATIO"
  | "MISALIGNED_EXECUTION_RANGE"
  | "EXECUTION_AGGREGATION_MISMATCH";

export interface ExecutionScheduleError {
  readonly code: ExecutionScheduleErrorCode;
}

export type ExecutionScheduleResult =
  | { readonly ok: true; readonly value: ExecutionSchedule }
  | { readonly ok: false; readonly error: ExecutionScheduleError };
