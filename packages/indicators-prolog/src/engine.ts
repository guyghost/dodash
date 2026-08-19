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
  readonly historicalVolatilityPeriod: number;
  readonly momentumPeriod: number;
  readonly returnPeriods: readonly number[];
  readonly vwapPeriod: number;
  readonly relativeVolumePeriod: number;
  readonly volumeSpikeThreshold: number;
  readonly volumeTrendPeriod: number;
  readonly trendStrengthPeriod: number;
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = Object.freeze({
  rsiPeriod: 14,
  emaFastPeriod: 12,
  emaSlowPeriod: 26,
  atrPeriod: 14,
  historicalVolatilityPeriod: 20,
  momentumPeriod: 10,
  returnPeriods: Object.freeze([1, 5, 20]),
  vwapPeriod: 20,
  relativeVolumePeriod: 20,
  volumeSpikeThreshold: 2,
  volumeTrendPeriod: 20,
  trendStrengthPeriod: 14,
});

export interface TradeSample {
  readonly price: number;
  readonly size: number;
}

export interface OrderBookLevel {
  readonly price: number;
  readonly size: number;
}

export interface OrderBookSnapshot {
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
}

export interface IndicatorMicrostructure {
  readonly trades?: readonly TradeSample[];
  readonly orderBook?: OrderBookSnapshot;
}

export interface OrderBookVwap {
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
}

export interface BidAskSpread {
  readonly absolute: number;
  readonly bps: number;
}

export interface IndicatorSnapshot {
  readonly snapshotId: string;
  readonly candleClosedAt: number;
  readonly rsi: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly macd: number;
  readonly atr: number;
  readonly historicalVolatility: number;
  readonly momentum: number;
  readonly periodicReturns: Readonly<Record<string, number>>;
  readonly ohlcvVwap: number | null;
  readonly tradeVwap: number | null;
  readonly orderBookVwap: OrderBookVwap | null;
  readonly bidAskSpread: BidAskSpread | null;
  readonly relativeVolume: number | null;
  readonly volumeSpike: boolean | null;
  readonly volumeTrend: number | null;
  readonly vwapDeviation: number | null;
  readonly trendStrength: number;
}

export type IndicatorError =
  | { readonly code: "INVALID_CANDLES"; readonly cause: MarketValidationError }
  | { readonly code: "INVALID_CONFIG" }
  | { readonly code: "INVALID_MICROSTRUCTURE" }
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

const parseAnswer = (formatted: string, variable: string): number | null => {
  const match = formatted.match(
    new RegExp(
      `${variable}\\s*=\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)`,
      "i",
    ),
  );
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const queryNumbers = (
  session: Session,
  indicator: string,
  goal: string,
  variables: readonly string[],
): Promise<Result<Readonly<Record<string, number>>, IndicatorError>> =>
  new Promise((resolve) => {
    session.query(goal, {
      success: () => {
        session.answer({
          success: (answer) => {
            const formatted = session.format_answer(answer);
            const values: Record<string, number> = {};
            for (const variable of variables) {
              const value = parseAnswer(formatted, variable);
              if (value === null) {
                resolve(err({ code: "NON_NUMERIC_RESULT", indicator }));
                return;
              }
              values[variable] = value;
            }
            resolve(ok(Object.freeze(values)));
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

const queryNumber = async (
  session: Session,
  indicator: string,
  goal: string,
): Promise<Result<number, IndicatorError>> => {
  const result = await queryNumbers(session, indicator, goal, ["Value"]);
  return result.ok ? ok(result.value.Value ?? 0) : result;
};

const asPrologList = (values: readonly number[]): string =>
  `[${values.map((value) => String(value)).join(",")}]`;

const validPeriod = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const validReturnPeriods = (periods: readonly number[]): boolean =>
  Array.isArray(periods) &&
  periods.length > 0 &&
  periods.every(
    (period, index) =>
      validPeriod(period) && (index === 0 || period > (periods[index - 1] ?? 0)),
  );

const validConfig = (config: IndicatorConfig): boolean =>
  validPeriod(config.rsiPeriod) &&
  validPeriod(config.emaFastPeriod) &&
  validPeriod(config.emaSlowPeriod) &&
  validPeriod(config.atrPeriod) &&
  validPeriod(config.historicalVolatilityPeriod) &&
  config.historicalVolatilityPeriod >= 2 &&
  validPeriod(config.momentumPeriod) &&
  validReturnPeriods(config.returnPeriods) &&
  validPeriod(config.vwapPeriod) &&
  validPeriod(config.relativeVolumePeriod) &&
  Number.isFinite(config.volumeSpikeThreshold) &&
  config.volumeSpikeThreshold > 0 &&
  validPeriod(config.volumeTrendPeriod) &&
  config.volumeTrendPeriod >= 2 &&
  validPeriod(config.trendStrengthPeriod) &&
  config.emaFastPeriod < config.emaSlowPeriod;

export const requiredIndicatorCandles = (config: IndicatorConfig): number =>
  Math.max(
    config.rsiPeriod + 1,
    config.emaSlowPeriod,
    config.atrPeriod,
    config.historicalVolatilityPeriod + 1,
    config.momentumPeriod + 1,
    (config.returnPeriods.at(-1) ?? 0) + 1,
    config.vwapPeriod,
    config.relativeVolumePeriod + 1,
    config.volumeTrendPeriod,
    config.trendStrengthPeriod * 2,
  );

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const validMicrostructure = (
  microstructure: IndicatorMicrostructure | undefined,
): boolean => {
  if (microstructure === undefined) return true;
  if (
    microstructure.trades !== undefined &&
    (!Array.isArray(microstructure.trades) ||
      !microstructure.trades.every(
        (trade) => isPositiveFinite(trade.price) && isPositiveFinite(trade.size),
      ))
  ) {
    return false;
  }
  const book = microstructure.orderBook;
  if (book === undefined) return true;
  if (
    !Array.isArray(book.bids) ||
    !Array.isArray(book.asks) ||
    ![...book.bids, ...book.asks].every(
      (level) => isPositiveFinite(level.price) && isPositiveFinite(level.size),
    )
  ) {
    return false;
  }
  if (book.bids.length === 0 || book.asks.length === 0) return true;
  const bestBid = Math.max(...book.bids.map((level) => level.price));
  const bestAsk = Math.min(...book.asks.map((level) => level.price));
  return bestBid <= bestAsk;
};

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
  microstructure?: IndicatorMicrostructure,
): Promise<Result<IndicatorSnapshot, IndicatorError>> => {
  const validated = validateCandleSeries(candles);
  if (!validated.ok) {
    return err({ code: "INVALID_CANDLES", cause: validated.error });
  }

  if (!validConfig(config)) {
    return err({ code: "INVALID_CONFIG" });
  }
  if (!validMicrostructure(microstructure)) {
    return err({ code: "INVALID_MICROSTRUCTURE" });
  }

  const required = requiredIndicatorCandles(config);
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
  const session = pl.create(1_000_000);
  const consulted = await consult(session);
  if (!consulted.ok) return consulted;

  const last = validated.value.at(-1);
  if (last === undefined) {
    return err({ code: "INSUFFICIENT_CANDLES", required, actual: 0 });
  }
  const closeValues = validated.value.map((candle) => candle.close);
  const highValues = validated.value.map((candle) => candle.high);
  const lowValues = validated.value.map((candle) => candle.low);
  const volumeValues = validated.value.map((candle) => candle.volume);
  const fixedWindowList = (values: readonly number[], length: number): string =>
    asPrologList(values.slice(-length));
  const candleValues: Record<string, number> = {};
  const fixedGoals: readonly (readonly [string, string])[] = [
    [
      "Rsi",
      `rsi(${fixedWindowList(closeValues, config.rsiPeriod + 1)}, ${config.rsiPeriod}, Value).`,
    ],
    ["EmaFast", `ema(${closes}, ${config.emaFastPeriod}, Value).`],
    ["EmaSlow", `ema(${closes}, ${config.emaSlowPeriod}, Value).`],
    [
      "Macd",
      `macd(${closes}, ${config.emaFastPeriod}, ${config.emaSlowPeriod}, Value).`,
    ],
    ["Atr", `atr(${highs}, ${lows}, ${closes}, ${config.atrPeriod}, Value).`],
    [
      "HistoricalVolatility",
      `historical_volatility(${fixedWindowList(closeValues, config.historicalVolatilityPeriod + 1)}, ${config.historicalVolatilityPeriod}, Value).`,
    ],
    [
      "Momentum",
      `momentum(${fixedWindowList(closeValues, config.momentumPeriod + 1)}, ${config.momentumPeriod}, Value).`,
    ],
    [
      "TrendStrength",
      `trend_strength(${fixedWindowList(highValues, config.trendStrengthPeriod * 2)}, ${fixedWindowList(lowValues, config.trendStrengthPeriod * 2)}, ${fixedWindowList(closeValues, config.trendStrengthPeriod * 2)}, ${config.trendStrengthPeriod}, Value).`,
    ],
  ];
  for (const [indicator, goal] of fixedGoals) {
    const result = await queryNumber(session, indicator, goal);
    if (!result.ok) return result;
    candleValues[indicator] = result.value;
  }

  const periodicReturns: Record<string, number> = {};
  for (const period of config.returnPeriods) {
    const result = await queryNumber(
      session,
      `periodic-return-${period}`,
      `periodic_return(${fixedWindowList(closeValues, period + 1)}, ${period}, Value).`,
    );
    if (!result.ok) return result;
    periodicReturns[String(period)] = result.value;
  }

  const vwapVolume = validated.value
    .slice(-config.vwapPeriod)
    .reduce((sum, candle) => sum + candle.volume, 0);
  const hasOhlcvVwap = vwapVolume > 0;
  let ohlcvVwap: number | null = null;
  let vwapDeviation: number | null = null;
  if (hasOhlcvVwap) {
    const vwap = await queryNumber(
      session,
      "ohlcv-vwap",
      `ohlcv_vwap(${fixedWindowList(highValues, config.vwapPeriod)}, ${fixedWindowList(lowValues, config.vwapPeriod)}, ${fixedWindowList(closeValues, config.vwapPeriod)}, ${fixedWindowList(volumeValues, config.vwapPeriod)}, ${config.vwapPeriod}, Value).`,
    );
    if (!vwap.ok) return vwap;
    ohlcvVwap = vwap.value;
    const deviation = await queryNumber(
      session,
      "vwap-deviation",
      `vwap_deviation(${last.close}, ${vwap.value}, Value).`,
    );
    if (!deviation.ok) return deviation;
    vwapDeviation = deviation.value;
  }

  const relativeVolumeReference = validated.value
    .slice(-(config.relativeVolumePeriod + 1), -1)
    .reduce((sum, candle) => sum + candle.volume, 0);
  const hasRelativeVolume = relativeVolumeReference > 0;
  let relativeVolume: number | null = null;
  let volumeSpike: boolean | null = null;
  if (hasRelativeVolume) {
    const relative = await queryNumber(
      session,
      "relative-volume",
      `relative_volume(${fixedWindowList(volumeValues, config.relativeVolumePeriod + 1)}, ${config.relativeVolumePeriod}, Value).`,
    );
    if (!relative.ok) return relative;
    relativeVolume = relative.value;
    const spike = await queryNumber(
      session,
      "volume-spike",
      `volume_spike(${relative.value}, ${config.volumeSpikeThreshold}, Value).`,
    );
    if (!spike.ok) return spike;
    volumeSpike = spike.value === 1;
  }

  const volumeTrendSum = validated.value
    .slice(-config.volumeTrendPeriod)
    .reduce((sum, candle) => sum + candle.volume, 0);
  const hasVolumeTrend = volumeTrendSum > 0;
  let volumeTrend: number | null = null;
  if (hasVolumeTrend) {
    const trend = await queryNumber(
      session,
      "volume-trend",
      `volume_trend(${fixedWindowList(volumeValues, config.volumeTrendPeriod)}, ${config.volumeTrendPeriod}, Value).`,
    );
    if (!trend.ok) return trend;
    volumeTrend = trend.value;
  }

  let tradeVwap: number | null = null;
  let orderBookVwap: OrderBookVwap | null = null;
  let bidAskSpread: BidAskSpread | null = null;
  const microGoals: string[] = [];
  const microVariables: string[] = [];
  const trades = microstructure?.trades ?? [];
  if (trades.length > 0) {
    microVariables.push("TradeVwap");
    microGoals.push(
      `weighted_vwap(${asPrologList(trades.map((trade) => trade.price))}, ${asPrologList(trades.map((trade) => trade.size))}, TradeVwap)`,
    );
  }
  const book = microstructure?.orderBook;
  if (book !== undefined && book.bids.length > 0 && book.asks.length > 0) {
    const bidPrices = asPrologList(book.bids.map((level) => level.price));
    const bidSizes = asPrologList(book.bids.map((level) => level.size));
    const askPrices = asPrologList(book.asks.map((level) => level.price));
    const askSizes = asPrologList(book.asks.map((level) => level.size));
    microVariables.push(
      "BookBidVwap",
      "BookAskVwap",
      "BookMidVwap",
      "SpreadAbsolute",
      "SpreadBps",
    );
    microGoals.push(
      `weighted_vwap(${bidPrices}, ${bidSizes}, BookBidVwap)`,
      `weighted_vwap(${askPrices}, ${askSizes}, BookAskVwap)`,
      "midpoint(BookBidVwap, BookAskVwap, BookMidVwap)",
      `spread_absolute(${bidPrices}, ${askPrices}, SpreadAbsolute)`,
      `spread_bps(${bidPrices}, ${askPrices}, SpreadBps)`,
    );
  }
  if (microGoals.length > 0) {
    const microValues = await queryNumbers(
      session,
      "microstructure-indicators",
      `${microGoals.join(", ")}.`,
      microVariables,
    );
    if (!microValues.ok) return microValues;
    tradeVwap = microValues.value.TradeVwap ?? null;
    if (book !== undefined && book.bids.length > 0 && book.asks.length > 0) {
      orderBookVwap = Object.freeze({
        bid: microValues.value.BookBidVwap ?? 0,
        ask: microValues.value.BookAskVwap ?? 0,
        mid: microValues.value.BookMidVwap ?? 0,
      });
      bidAskSpread = Object.freeze({
        absolute: microValues.value.SpreadAbsolute ?? 0,
        bps: microValues.value.SpreadBps ?? 0,
      });
    }
  }

  const snapshotId = hashSnapshot(
    JSON.stringify({ candles: validated.value, config, microstructure: microstructure ?? null }),
  );
  return ok(
    Object.freeze({
      snapshotId,
      candleClosedAt: last.start,
      rsi: candleValues.Rsi ?? 0,
      emaFast: candleValues.EmaFast ?? 0,
      emaSlow: candleValues.EmaSlow ?? 0,
      macd: candleValues.Macd ?? 0,
      atr: candleValues.Atr ?? 0,
      historicalVolatility: candleValues.HistoricalVolatility ?? 0,
      momentum: candleValues.Momentum ?? 0,
      periodicReturns: Object.freeze(periodicReturns),
      ohlcvVwap,
      tradeVwap,
      orderBookVwap,
      bidAskSpread,
      relativeVolume,
      volumeSpike,
      volumeTrend,
      vwapDeviation,
      trendStrength: candleValues.TrendStrength ?? 0,
    }),
  );
};
