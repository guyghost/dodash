import {
  createProductId,
  err,
  ok,
  type ProductId,
  type Result,
  type Timeframe,
} from "@dodash/domain";
import {
  isValidProtectiveExitPolicy,
  type ProtectiveExitPolicy,
} from "@dodash/models";

const timeframeMs: Readonly<Record<Timeframe, number>> = Object.freeze({
  ONE_MINUTE: 60_000,
  FIVE_MINUTE: 300_000,
  FIFTEEN_MINUTE: 900_000,
  ONE_HOUR: 3_600_000,
  SIX_HOUR: 21_600_000,
  ONE_DAY: 86_400_000,
});

const isTimeframe = (value: string): value is Timeframe =>
  Object.hasOwn(timeframeMs, value);

const parseUtcDate = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ? timestamp
    : null;
};

const formatUtcDate = (timestamp: number): string =>
  new Date(timestamp).toISOString().slice(0, 10);

export interface BacktestCliOptions {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly executionTimeframe: Timeframe | null;
  readonly targetSignalNotional: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly outputPath: string;
  readonly protectiveExit: BacktestCliProtectiveExitPolicy;
}

export type BacktestCliProtectiveExitPolicy = Extract<
  ProtectiveExitPolicy,
  { readonly mode: "NONE" } | { readonly mode: "FIXED_BPS" }
>;

export type BacktestCliOptionsError = { readonly code: "INVALID_CLI_OPTIONS" };

export const createBacktestRunId = (options: BacktestCliOptions): string => {
  const manifestParts: readonly (string | number)[] = [
    "notional",
    options.targetSignalNotional,
    ...(options.executionTimeframe === null
      ? []
      : ["exec", options.executionTimeframe]),
    ...(options.protectiveExit.mode === "NONE"
      ? []
      : [
          "protective",
          options.protectiveExit.mode,
          options.protectiveExit.stopLossBps,
          options.protectiveExit.takeProfitBps,
        ]),
  ];
  return [
    "bt",
    options.productId,
    options.timeframe,
    ...manifestParts,
    options.startAt,
    options.endAt,
  ].join(":");
};

export const parseBacktestCliOptions = (
  args: readonly string[],
  now = Date.now(),
): Result<BacktestCliOptions, BacktestCliOptionsError> => {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    normalizedArgs.length % 2 !== 0
  ) {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }
  const values = new Map<string, string>();
  const allowed = new Set([
    "--product",
    "--timeframe",
    "--execution-timeframe",
    "--target-signal-notional",
    "--protective-exit",
    "--stop-loss-bps",
    "--take-profit-bps",
    "--start",
    "--end",
    "--output",
  ]);
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      values.has(key) ||
      value.trim().length === 0
    ) {
      return err({ code: "INVALID_CLI_OPTIONS" });
    }
    values.set(key, value);
  }

  const timeframeRaw = values.get("--timeframe") ?? "ONE_DAY";
  if (!isTimeframe(timeframeRaw)) return err({ code: "INVALID_CLI_OPTIONS" });
  const duration = timeframeMs[timeframeRaw];
  const executionTimeframeRaw = values.get("--execution-timeframe");
  const executionTimeframe =
    executionTimeframeRaw === undefined || !isTimeframe(executionTimeframeRaw)
      ? null
      : executionTimeframeRaw;
  if (
    (executionTimeframeRaw !== undefined && executionTimeframe === null) ||
    (executionTimeframe !== null &&
      (timeframeMs[executionTimeframe] >= duration ||
        duration % timeframeMs[executionTimeframe] !== 0))
  ) {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }

  const protectiveMode = values.get("--protective-exit") ?? "NONE";
  const stopLossRaw = values.get("--stop-loss-bps");
  const takeProfitRaw = values.get("--take-profit-bps");
  let protectiveExit: BacktestCliProtectiveExitPolicy;
  if (protectiveMode === "NONE") {
    if (stopLossRaw !== undefined || takeProfitRaw !== undefined) {
      return err({ code: "INVALID_CLI_OPTIONS" });
    }
    protectiveExit = Object.freeze({ mode: "NONE" as const });
  } else if (
    protectiveMode === "FIXED_BPS" &&
    stopLossRaw !== undefined &&
    takeProfitRaw !== undefined
  ) {
    const candidate = Object.freeze({
      mode: "FIXED_BPS" as const,
      stopLossBps: Number(stopLossRaw),
      takeProfitBps: Number(takeProfitRaw),
    });
    if (!isValidProtectiveExitPolicy(candidate)) {
      return err({ code: "INVALID_CLI_OPTIONS" });
    }
    protectiveExit = candidate;
  } else {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }

  const targetSignalNotional = Number(
    values.get("--target-signal-notional") ?? "1000",
  );
  if (!Number.isFinite(targetSignalNotional) || targetSignalNotional <= 0) {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }

  const latestClosedBoundary = Math.floor(now / duration) * duration;
  const startAt = values.has("--start")
    ? parseUtcDate(values.get("--start") as string)
    : latestClosedBoundary - 365 * duration;
  const endAt = values.has("--end")
    ? parseUtcDate(values.get("--end") as string)
    : latestClosedBoundary;
  const product = createProductId(values.get("--product") ?? "BTC-USD");
  if (
    !product.ok ||
    startAt === null ||
    endAt === null ||
    startAt < duration ||
    endAt <= startAt ||
    endAt > latestClosedBoundary ||
    startAt % duration !== 0 ||
    endAt % duration !== 0
  ) {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }
  const executionSuffix =
    executionTimeframe === null ? "" : `-exec-${executionTimeframe}`;
  const notionalSuffix = `-notional-${targetSignalNotional}`;
  const protectiveSuffix =
    protectiveExit.mode === "NONE"
      ? ""
      : `-fixed-${protectiveExit.stopLossBps}-${protectiveExit.takeProfitBps}`;
  const outputPath = values.get("--output") ??
    `.artifacts/backtests/${product.value}-${timeframeRaw}${notionalSuffix}${executionSuffix}${protectiveSuffix}-${formatUtcDate(startAt)}-${formatUtcDate(endAt)}.json`;
  return ok(
    Object.freeze({
      productId: product.value,
      timeframe: timeframeRaw,
      executionTimeframe,
      targetSignalNotional,
      startAt,
      endAt,
      outputPath,
      protectiveExit,
    }),
  );
};
