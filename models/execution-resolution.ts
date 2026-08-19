import type {
  ExecutionCandle,
  ExecutionSchedule,
  ExecutionScheduleBucket,
  ExecutionScheduleErrorCode,
  ExecutionScheduleResult,
} from "./execution-resolution.types.js";

const ok = (value: ExecutionSchedule): ExecutionScheduleResult =>
  Object.freeze({ ok: true as const, value });
const err = (code: ExecutionScheduleErrorCode): ExecutionScheduleResult =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code }) });

const closeEnough = (left: number, right: number): boolean =>
  Math.abs(left - right) <=
  Math.max(1, Math.abs(left), Math.abs(right)) * Number.EPSILON * 64;

const uniformInterval = (
  candles: readonly ExecutionCandle[],
): number | null => {
  const first = candles[0];
  const second = candles[1];
  if (first === undefined || second === undefined) return null;
  const interval = second.start - first.start;
  if (!Number.isSafeInteger(interval) || interval <= 0) return null;
  return candles.every(
    (candle, index) =>
      index === 0 ||
      candle.start === (candles[index - 1]?.start ?? candle.start) + interval,
  )
    ? interval
    : null;
};

const aggregatesToPrimary = (
  primary: ExecutionCandle,
  execution: readonly ExecutionCandle[],
): boolean => {
  const first = execution[0];
  const last = execution.at(-1);
  if (first === undefined || last === undefined) return false;
  const high = Math.max(...execution.map((candle) => candle.high));
  const low = Math.min(...execution.map((candle) => candle.low));
  return (
    closeEnough(primary.open, first.open) &&
    closeEnough(primary.close, last.close) &&
    closeEnough(primary.high, high) &&
    closeEnough(primary.low, low)
  );
};

const oneToOneSchedule = (
  primaryCandles: readonly ExecutionCandle[],
): ExecutionSchedule =>
  Object.freeze({
    resolutionRatio: 1,
    buckets: Object.freeze(
      primaryCandles.map((primaryCandle) =>
        Object.freeze({
          primaryCandle,
          executionCandles: Object.freeze([primaryCandle]),
        }),
      ),
    ),
  });

export const createExecutionSchedule = (
  primaryCandles: readonly ExecutionCandle[],
  executionCandles?: readonly ExecutionCandle[],
): ExecutionScheduleResult => {
  if (primaryCandles.length === 0) return err("EMPTY_PRIMARY_SERIES");
  if (executionCandles === undefined) return ok(oneToOneSchedule(primaryCandles));
  if (primaryCandles.length < 2) return err("INSUFFICIENT_PRIMARY_CANDLES");
  if (executionCandles.length < 2) return err("INSUFFICIENT_EXECUTION_CANDLES");

  const primaryInterval = uniformInterval(primaryCandles);
  if (primaryInterval === null) return err("NON_UNIFORM_PRIMARY_INTERVAL");

  const firstExecution = executionCandles[0];
  const secondExecution = executionCandles[1];
  if (firstExecution === undefined || secondExecution === undefined) {
    return err("INSUFFICIENT_EXECUTION_CANDLES");
  }
  const executionInterval = secondExecution.start - firstExecution.start;
  if (!Number.isSafeInteger(executionInterval) || executionInterval <= 0) {
    return err("NON_UNIFORM_EXECUTION_INTERVAL");
  }
  if (
    executionInterval >= primaryInterval ||
    primaryInterval % executionInterval !== 0
  ) {
    return err("INVALID_EXECUTION_RATIO");
  }
  const resolutionRatio = primaryInterval / executionInterval;
  const firstPrimary = primaryCandles[0];
  const expectedExecutionCount = primaryCandles.length * resolutionRatio;
  if (
    firstPrimary === undefined ||
    executionCandles.length !== expectedExecutionCount ||
    firstExecution.start !== firstPrimary.start
  ) {
    return err("MISALIGNED_EXECUTION_RANGE");
  }
  if (uniformInterval(executionCandles) !== executionInterval) {
    return err("NON_UNIFORM_EXECUTION_INTERVAL");
  }

  const buckets: ExecutionScheduleBucket[] = [];
  for (let index = 0; index < primaryCandles.length; index += 1) {
    const primaryCandle = primaryCandles[index];
    if (primaryCandle === undefined) return err("MISALIGNED_EXECUTION_RANGE");
    const start = index * resolutionRatio;
    const execution = executionCandles.slice(start, start + resolutionRatio);
    if (
      execution.length !== resolutionRatio ||
      execution[0]?.start !== primaryCandle.start
    ) {
      return err("MISALIGNED_EXECUTION_RANGE");
    }
    if (!aggregatesToPrimary(primaryCandle, execution)) {
      return err("EXECUTION_AGGREGATION_MISMATCH");
    }
    buckets.push(
      Object.freeze({
        primaryCandle,
        executionCandles: Object.freeze(execution),
      }),
    );
  }

  return ok(
    Object.freeze({
      resolutionRatio,
      buckets: Object.freeze(buckets),
    }),
  );
};
