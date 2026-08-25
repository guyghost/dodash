import { createSignal, err } from "@dodash/domain";
import { resolveTargetSignalQuantity } from "@dodash/models";

import type { Strategy, StrategyContext } from "./strategy.js";

export const withTargetSignalNotional = (
  strategy: Strategy,
  targetSignalNotional: number,
): Strategy =>
  Object.freeze({
    id: strategy.id,
    evaluate: (context: StrategyContext) => {
      const evaluated = strategy.evaluate(context);
      if (!evaluated.ok || evaluated.value.side === "HOLD") return evaluated;

      const referencePrice = context.candles.at(-1)?.close;
      const sizing = resolveTargetSignalQuantity(
        targetSignalNotional,
        referencePrice ?? Number.NaN,
      );
      if (!sizing.ok) {
        return err({
          code: "INVALID_STRATEGY_SIGNAL" as const,
          strategyId: strategy.id,
          cause: { code: "INVALID_SUGGESTED_SIZE" as const },
        });
      }
      const resized = createSignal({
        ...evaluated.value,
        suggestedSize: sizing.value,
      });
      return resized.ok
        ? resized
        : err({
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: strategy.id,
            cause: resized.error,
          });
    },
  });
