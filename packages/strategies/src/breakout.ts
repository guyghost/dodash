import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

export interface BreakoutConfig {
  readonly id?: string;
  readonly lookback: number;
  readonly baseSize: number;
  readonly minRelativeVolume?: number;
  readonly positionAware?: boolean;
  readonly allowShort?: boolean;
}

const blockedHold = (
  id: string,
  productId: StrategyContext["productId"],
  reasonCode: string,
) =>
  strategySignal(
    id,
    createSignal({
      strategyId: id,
      productId,
      side: "HOLD",
      confidence: 0,
      suggestedSize: 0,
      reasonCode,
    }),
  );

export const createBreakoutStrategy = (config: BreakoutConfig): Strategy => {
  const id = config.id ?? "breakout";
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      if (
        !Number.isSafeInteger(config.lookback) ||
        config.lookback < 2 ||
        !Number.isFinite(config.baseSize) ||
        config.baseSize <= 0 ||
        (config.minRelativeVolume !== undefined &&
          (!Number.isFinite(config.minRelativeVolume) ||
            config.minRelativeVolume <= 0))
      ) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }
      if (context.candles.length < config.lookback + 1) {
        return {
          ok: false as const,
          error: { code: "INSUFFICIENT_STRATEGY_DATA" as const, strategyId: id },
        };
      }

      const latest = context.candles.at(-1);
      const history = context.candles.slice(-(config.lookback + 1), -1);
      if (latest === undefined || history.length !== config.lookback) {
        return {
          ok: false as const,
          error: { code: "INSUFFICIENT_STRATEGY_DATA" as const, strategyId: id },
        };
      }
      const highest = Math.max(...history.map((candle) => candle.high));
      const lowest = Math.min(...history.map((candle) => candle.low));
      const side = latest.close > highest ? "BUY" : latest.close < lowest ? "SELL" : "HOLD";

      if (side !== "HOLD") {
        if (config.positionAware === true) {
          if (side === "BUY" && context.positionSide === "LONG") {
            return blockedHold(id, context.productId, "BREAKOUT_ALREADY_LONG");
          }
          if (
            side === "SELL" &&
            context.positionSide === "FLAT" &&
            config.allowShort !== true
          ) {
            return blockedHold(id, context.productId, "BREAKOUT_NO_POSITION_TO_SELL");
          }
          if (side === "SELL" && context.positionSide === "SHORT") {
            return blockedHold(id, context.productId, "BREAKOUT_ALREADY_SHORT");
          }
        }

        const isOpeningContext =
          config.positionAware !== true ||
          context.positionSide === undefined ||
          context.positionSide === "FLAT";
        if (config.minRelativeVolume !== undefined && isOpeningContext) {
          const relVol = context.indicators.relativeVolume;
          if (
            relVol === null ||
            !Number.isFinite(relVol) ||
            relVol < config.minRelativeVolume
          ) {
            return blockedHold(id, context.productId, "BREAKOUT_LOW_VOLUME");
          }
        }
      }

      const boundary = side === "SELL" ? lowest : highest;
      const confidence =
        side === "HOLD"
          ? 0
          : Math.min(1, Math.abs(latest.close - boundary) / Math.max(boundary, Number.EPSILON));

      return strategySignal(
        id,
        createSignal({
          strategyId: id,
          productId: context.productId,
          side,
          confidence,
          suggestedSize: side === "HOLD" ? 0 : config.baseSize,
          reasonCode:
            side === "BUY"
              ? "BREAKOUT_UP"
              : side === "SELL"
                ? "BREAKOUT_DOWN"
                : "BREAKOUT_INSIDE_RANGE",
        }),
      );
    },
  });
};
