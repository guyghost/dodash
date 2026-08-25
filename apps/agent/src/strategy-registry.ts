import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  withConfidenceCalibration,
  withTargetSignalNotional,
  type Strategy,
} from "@dodash/strategies";

import type { AgentConfiguration } from "./configuration.js";

export const createConfiguredStrategyRegistry = (
  configuration: AgentConfiguration,
) => {
  const strategies = configuration.strategyIds.map((id) => {
    let strategy: Strategy;
    switch (id) {
      case "rsi-reversion":
        strategy = createRsiReversionStrategy({
          id,
          oversold: 30,
          overbought: 70,
          baseSize: 0.01,
        });
        break;
      case "ema-cross":
        strategy = createEmaCrossStrategy({ id, baseSize: 0.01 });
        break;
      case "breakout":
        strategy = createBreakoutStrategy({ id, lookback: 20, baseSize: 0.01 });
        break;
      default:
        throw new Error(`Unsupported strategy id: ${id}`);
    }
    if (configuration.sizingPolicy.type === "NATIVE") return strategy;
    const calibrated =
      id === "rsi-reversion"
        ? strategy
        : withConfidenceCalibration(
            strategy,
            configuration.sizingPolicy.confidenceCalibration,
          );
    return withTargetSignalNotional(
      calibrated,
      configuration.sizingPolicy.targetSignalNotional,
    );
  });
  const registry = createStrategyRegistry(strategies);
  if (!registry.ok) {
    throw new Error("Validated strategies produced an invalid registry");
  }
  return registry.value;
};
