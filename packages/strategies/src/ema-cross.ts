import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

export interface EmaCrossConfig {
  readonly id?: string;
  readonly baseSize: number;
}

export const createEmaCrossStrategy = (config: EmaCrossConfig): Strategy => {
  const id = config.id ?? "ema-cross";
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      if (!Number.isFinite(config.baseSize) || config.baseSize <= 0) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const previous = context.previousIndicators;
      const crossedUp =
        previous !== null &&
        previous.emaFast <= previous.emaSlow &&
        context.indicators.emaFast > context.indicators.emaSlow;
      const crossedDown =
        previous !== null &&
        previous.emaFast >= previous.emaSlow &&
        context.indicators.emaFast < context.indicators.emaSlow;
      const side = crossedUp ? "BUY" : crossedDown ? "SELL" : "HOLD";
      const denominator = Math.max(Math.abs(context.indicators.emaSlow), Number.EPSILON);
      const confidence = Math.min(
        1,
        Math.abs(context.indicators.emaFast - context.indicators.emaSlow) /
          denominator,
      );

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
              ? "EMA_CROSS_UP"
              : side === "SELL"
                ? "EMA_CROSS_DOWN"
                : previous === null
                  ? "EMA_WARMUP"
                  : "EMA_NO_CROSS",
        }),
      );
    },
  });
};
