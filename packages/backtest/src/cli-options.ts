import {
  createProductId,
  err,
  ok,
  type ProductId,
  type Result,
  type Timeframe,
} from "@dodash/domain";

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
  readonly startAt: number;
  readonly endAt: number;
  readonly outputPath: string;
}

export type BacktestCliOptionsError = { readonly code: "INVALID_CLI_OPTIONS" };

export const parseBacktestCliOptions = (
  args: readonly string[],
  now = Date.now(),
): Result<BacktestCliOptions, BacktestCliOptionsError> => {
  if (!Number.isSafeInteger(now) || now < 0 || args.length % 2 !== 0) {
    return err({ code: "INVALID_CLI_OPTIONS" });
  }
  const values = new Map<string, string>();
  const allowed = new Set(["--product", "--timeframe", "--start", "--end", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
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
  const outputPath =
    values.get("--output") ??
    `.artifacts/backtests/${product.value}-${timeframeRaw}-${formatUtcDate(startAt)}-${formatUtcDate(endAt)}.json`;
  return ok(
    Object.freeze({
      productId: product.value,
      timeframe: timeframeRaw,
      startAt,
      endAt,
      outputPath,
    }),
  );
};
