import {
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type MarketValidationError,
  type Result,
} from "@dodash/domain";
import pl from "tau-prolog";

import { PROLOG_SOURCE } from "./prolog-source.js";

export interface IndicatorConfig {
  readonly rsiPeriod: number;
  readonly emaFastPeriod: number;
  readonly emaSlowPeriod: number;
  readonly atrPeriod: number;
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  rsiPeriod: 14,
  emaFastPeriod: 12,
  emaSlowPeriod: 26,
  atrPeriod: 14,
};

export interface IndicatorSnapshot {
  readonly snapshotId: string;
  readonly candleClosedAt: number;
  readonly rsi: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly macd: number;
  readonly atr: number;
}

export type IndicatorError =
  | { readonly code: "INVALID_CANDLES"; readonly cause: MarketValidationError }
  | { readonly code: "INVALID_CONFIG" }
  | { readonly code: "INSUFFICIENT_CANDLES"; readonly required: number; readonly actual: number }
  | { readonly code: "PROLOG_PARSE_ERROR" }
  | { readonly code: "PROLOG_QUERY_ERROR"; readonly indicator: string }
  | { readonly code: "PROLOG_QUERY_FAILED"; readonly indicator: string }
  | { readonly code: "PROLOG_LIMIT_EXCEEDED"; readonly indicator: string }
  | { readonly code: "NON_NUMERIC_RESULT"; readonly indicator: string };

type Session = ReturnType<typeof pl.create>;

const consult = (session: Session): Promise<Result<void, IndicatorError>> =>
  new Promise((resolve) => {
    session.consult(PROLOG_SOURCE, {
      success: () => resolve(ok(undefined)),
      error: () => resolve(err({ code: "PROLOG_PARSE_ERROR" })),
    });
  });

const parseAnswer = (formatted: string): number | null => {
  const match = formatted.match(
    /Value\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i,
  );
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const queryNumber = (
  session: Session,
  indicator: string,
  goal: string,
): Promise<Result<number, IndicatorError>> =>
  new Promise((resolve) => {
    session.query(goal, {
      success: () => {
        session.answer({
          success: (answer) => {
            const value = parseAnswer(session.format_answer(answer));
            resolve(
              value === null
                ? err({ code: "NON_NUMERIC_RESULT", indicator })
                : ok(value),
            );
          },
          error: () => resolve(err({ code: "PROLOG_QUERY_ERROR", indicator })),
          fail: () => resolve(err({ code: "PROLOG_QUERY_FAILED", indicator })),
          limit: () =>
            resolve(err({ code: "PROLOG_LIMIT_EXCEEDED", indicator })),
        });
      },
      error: () => resolve(err({ code: "PROLOG_QUERY_ERROR", indicator })),
    });
  });

const asPrologList = (values: readonly number[]): string =>
  `[${values.map((value) => String(value)).join(",")}]`;

const validPeriod = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const hashSnapshot = (source: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ind-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const computeIndicators = async (
  candles: readonly Candle[],
  config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): Promise<Result<IndicatorSnapshot, IndicatorError>> => {
  const validated = validateCandleSeries(candles);
  if (!validated.ok) {
    return err({ code: "INVALID_CANDLES", cause: validated.error });
  }

  if (
    !validPeriod(config.rsiPeriod) ||
    !validPeriod(config.emaFastPeriod) ||
    !validPeriod(config.emaSlowPeriod) ||
    !validPeriod(config.atrPeriod) ||
    config.emaFastPeriod >= config.emaSlowPeriod
  ) {
    return err({ code: "INVALID_CONFIG" });
  }

  const required = Math.max(
    config.rsiPeriod + 1,
    config.emaSlowPeriod,
    config.atrPeriod,
  );
  if (validated.value.length < required) {
    return err({
      code: "INSUFFICIENT_CANDLES",
      required,
      actual: validated.value.length,
    });
  }

  const closes = asPrologList(validated.value.map((candle) => candle.close));
  const highs = asPrologList(validated.value.map((candle) => candle.high));
  const lows = asPrologList(validated.value.map((candle) => candle.low));
  const session = pl.create(250_000);
  const consulted = await consult(session);
  if (!consulted.ok) return consulted;

  const goals = [
    ["rsi", `rsi(${closes}, ${config.rsiPeriod}, Value).`],
    ["emaFast", `ema(${closes}, ${config.emaFastPeriod}, Value).`],
    ["emaSlow", `ema(${closes}, ${config.emaSlowPeriod}, Value).`],
    [
      "macd",
      `macd(${closes}, ${config.emaFastPeriod}, ${config.emaSlowPeriod}, Value).`,
    ],
    ["atr", `atr(${highs}, ${lows}, ${closes}, ${config.atrPeriod}, Value).`],
  ] as const;

  const values: Record<(typeof goals)[number][0], number> = {
    rsi: 0,
    emaFast: 0,
    emaSlow: 0,
    macd: 0,
    atr: 0,
  };
  for (const [indicator, goal] of goals) {
    const result = await queryNumber(session, indicator, goal);
    if (!result.ok) return result;
    values[indicator] = result.value;
  }

  const last = validated.value.at(-1);
  if (last === undefined) {
    return err({ code: "INSUFFICIENT_CANDLES", required, actual: 0 });
  }
  const snapshotId = hashSnapshot(
    `${last.start}:${validated.value.length}:${config.rsiPeriod}:${config.emaFastPeriod}:${config.emaSlowPeriod}:${config.atrPeriod}`,
  );
  return ok(
    Object.freeze({
      snapshotId,
      candleClosedAt: last.start,
      rsi: values.rsi,
      emaFast: values.emaFast,
      emaSlow: values.emaSlow,
      macd: values.macd,
      atr: values.atr,
    }),
  );
};

