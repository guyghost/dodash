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
  readonly maxTrendStrength?: number;
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
        config.baseSize <= 0 ||
        (config.maxTrendStrength !== undefined &&
          (!Number.isFinite(config.maxTrendStrength) ||
            config.maxTrendStrength <= 0))
      ) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const rsi = context.indicators.rsi;
      const side =
        rsi < config.oversold ? "BUY" : rsi > config.overbought ? "SELL" : "HOLD";

      if (config.positionAware === true) {
        if (side === "BUY" && context.positionSide === "LONG") {
          return blockedHold(id, context.productId, "RSI_ALREADY_LONG");
        }
        if (
          side === "SELL" &&
          context.positionSide === "FLAT" &&
          config.allowShort !== true
        ) {
          return blockedHold(id, context.productId, "RSI_NO_POSITION_TO_SELL");
        }
        if (side === "SELL" && context.positionSide === "SHORT") {
          return blockedHold(id, context.productId, "RSI_ALREADY_SHORT");
        }
      }

      if (
        config.maxTrendStrength !== undefined &&
        context.indicators.trendStrength > config.maxTrendStrength
      ) {
        const isTrendBlocked =
          config.allowShort === true
            ? (side === "BUY" || side === "SELL") &&
              (context.positionSide === undefined ||
                context.positionSide === "FLAT")
            : side === "BUY";
        if (isTrendBlocked) {
          return blockedHold(id, context.productId, "RSI_TREND_BLOCKED");
        }
      }

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
