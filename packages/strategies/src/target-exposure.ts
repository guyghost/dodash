import { createSignal } from "@dodash/domain";
import { planTargetExposure } from "@dodash/models";

import { strategySignal, type Strategy, type StrategyContext } from "./strategy.js";

export const TARGET_EXPOSURE_STRATEGY_ID = "target-exposure";

/**
 * Signal informatif de la politique P7 (models/target-exposure.md §4) :
 * BUY si tendance (clôture > SMA200), SELL sinon, confiance = cible figée,
 * taille nulle. Il documente les entrées de la décision ; le dimensionnement
 * vient exclusivement de `planTargetExposure` dans l'étape d'allocation.
 */
export const createTargetExposureStrategy = (config: { readonly id?: string } = {}): Strategy => {
  const id = config.id ?? TARGET_EXPOSURE_STRATEGY_ID;
  return Object.freeze({
    id,
    evaluate: (context: StrategyContext) => {
      const plan = planTargetExposure({
        candles: context.candles,
        positionQuantity: 0,
        cash: 1,
        feeBps: 0,
        slippageBps: 0,
      });
      const ready = plan.reason !== "INSUFFICIENT_HISTORY" && plan.target !== null;
      const side = !ready ? "HOLD" : plan.trend === true ? "BUY" : "SELL";
      return strategySignal(
        id,
        createSignal({
          strategyId: id,
          productId: context.productId,
          side,
          confidence: ready ? (plan.target ?? 0) : 0,
          suggestedSize: 0,
          reasonCode: !ready
            ? "TARGET_EXPOSURE_WARMUP"
            : side === "BUY"
              ? "TARGET_EXPOSURE_TREND_UP"
              : "TARGET_EXPOSURE_TREND_DOWN",
        }),
      );
    },
  });
};
