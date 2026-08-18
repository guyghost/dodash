import {
  err,
  ok,
  type Candle,
  type ProductId,
  type Result,
  type Signal,
  type TradingValidationError,
} from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";

export interface StrategyContext {
  readonly productId: ProductId;
  readonly candles: readonly Candle[];
  readonly indicators: IndicatorSnapshot;
  readonly previousIndicators: IndicatorSnapshot | null;
}

export interface Strategy {
  readonly id: string;
  evaluate(context: StrategyContext): Result<Signal, StrategyError>;
}

export type StrategyError =
  | { readonly code: "INVALID_STRATEGY_CONFIG"; readonly strategyId: string }
  | { readonly code: "INSUFFICIENT_STRATEGY_DATA"; readonly strategyId: string }
  | {
      readonly code: "INVALID_STRATEGY_SIGNAL";
      readonly strategyId: string;
      readonly cause: TradingValidationError;
    }
  | { readonly code: "DUPLICATE_STRATEGY_ID"; readonly strategyId: string };

export interface StrategyRegistry {
  readonly ids: readonly string[];
  get(id: string): Strategy | undefined;
  evaluateAll(
    context: StrategyContext,
  ): Result<readonly Signal[], StrategyError>;
}

export const strategySignal = (
  strategyId: string,
  signal: Result<Signal, TradingValidationError>,
): Result<Signal, StrategyError> =>
  signal.ok
    ? signal
    : err({
        code: "INVALID_STRATEGY_SIGNAL",
        strategyId,
        cause: signal.error,
      });

export const createStrategyRegistry = (
  strategies: readonly Strategy[],
): Result<StrategyRegistry, StrategyError> => {
  const byId = new Map<string, Strategy>();
  for (const strategy of strategies) {
    if (byId.has(strategy.id)) {
      return err({ code: "DUPLICATE_STRATEGY_ID", strategyId: strategy.id });
    }
    byId.set(strategy.id, strategy);
  }

  const ids = Object.freeze([...byId.keys()].sort());
  return ok(
    Object.freeze({
      ids,
      get: (id: string) => byId.get(id),
      evaluateAll: (context: StrategyContext) => {
        const signals: Signal[] = [];
        for (const id of ids) {
          const strategy = byId.get(id);
          if (strategy === undefined) continue;
          const signal = strategy.evaluate(context);
          if (!signal.ok) return signal;
          signals.push(signal.value);
        }
        return ok(Object.freeze(signals));
      },
    }),
  );
};

