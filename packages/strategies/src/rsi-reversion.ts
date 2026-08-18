import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

export interface RsiReversionConfig {
  readonly id?: string;
  readonly oversold: number;
  readonly overbought: number;
  readonly baseSize: number;
}

export const createRsiReversionStrategy = (
  config: RsiReversionConfig,
): Strategy => {
  const id = config.id ?? "rsi-reversion";
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      if (
        !Number.isFinite(config.oversold) ||
        !Number.isFinite(config.overbought) ||
        !Number.isFinite(config.baseSize) ||
        config.oversold <= 0 ||
        config.overbought >= 100 ||
        config.oversold >= config.overbought ||
        config.baseSize <= 0
      ) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const rsi = context.indicators.rsi;
      const side =
        rsi < config.oversold ? "BUY" : rsi > config.overbought ? "SELL" : "HOLD";
      const confidence = Math.min(1, Math.abs(50 - rsi) / 50);
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
              ? "RSI_OVERSOLD"
              : side === "SELL"
                ? "RSI_OVERBOUGHT"
                : "RSI_NEUTRAL",
        }),
      );
    },
  });
};
