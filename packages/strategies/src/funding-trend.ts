import { createSignal } from "@dodash/domain";

import {
  strategySignal,
  type Strategy,
  type StrategyContext,
} from "./strategy.js";

/**
 * ID exporté pour le registre agent (C4, models/funding-rate-strategy.md
 * §7) : condition d'exclusion de la calibration explicite, sans
 * indirection.
 */
export const FUNDING_TREND_STRATEGY_ID = "funding-trend" as const;

export interface FundingTrendConfig {
  readonly id?: string;
  /**
   * Amplitude minimale de |fundingAvg| par période (décimal) qui autorise
   * un signal. Figée a priori : 5e-5 ≈ 4× la base Hyperliquid
   * (models/funding-rate-strategy.md §5). Aucun balayage.
   */
  readonly enterThreshold: number;
  readonly baseSize: number;
}

/**
 * Stratégie perp consciente du funding (models/funding-rate-strategy.md
 * §5) : le prix (paire EMA 12/26 du snapshot) donne le sens, le funding
 * moyen glissant donne l'autorisation d'amplitude. Pure, déterministe,
 * aucun LLM (INV-F4). Warm-up : fundingAvg absent ⇒ HOLD (INV-F3).
 */
export const createFundingTrendStrategy = (
  config: FundingTrendConfig,
): Strategy => {
  const id = config.id ?? FUNDING_TREND_STRATEGY_ID;
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      if (
        !Number.isFinite(config.enterThreshold) ||
        config.enterThreshold <= 0 ||
        !Number.isFinite(config.baseSize) ||
        config.baseSize <= 0
      ) {
        return {
          ok: false as const,
          error: { code: "INVALID_STRATEGY_CONFIG" as const, strategyId: id },
        };
      }

      const { fundingAvg } = context.indicators;
      if (fundingAvg === undefined || !Number.isFinite(fundingAvg)) {
        return strategySignal(
          id,
          createSignal({
            strategyId: id,
            productId: context.productId,
            side: "HOLD",
            confidence: 0,
            suggestedSize: 0,
            reasonCode: "FUNDING_WARMUP",
          }),
        );
      }

      const { emaFast, emaSlow } = context.indicators;
      const bullish = emaFast > emaSlow;
      const bearish = emaFast < emaSlow;
      const longCarry = fundingAvg <= -config.enterThreshold;
      const shortCrowding = fundingAvg >= config.enterThreshold;
      const side = bullish && longCarry
        ? "BUY"
        : bearish && shortCrowding
          ? "SELL"
          : "HOLD";
      const amplitude =
        (Math.abs(fundingAvg) - config.enterThreshold) / config.enterThreshold;
      const confidence = Math.min(1, Math.max(0, amplitude));

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
              ? "FUNDING_LONG_CARRY"
              : side === "SELL"
                ? "FUNDING_SHORT_CROWDING"
                : "FUNDING_NO_SIGNAL",
        }),
      );
    },
  });
};
