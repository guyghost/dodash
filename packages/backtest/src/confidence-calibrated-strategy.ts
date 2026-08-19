import { createSignal, err } from "@dodash/domain";
import {
  calibrateConfidence,
  isConfidenceCalibrationProfile,
  type ConfidenceCalibrationProfile,
} from "@dodash/models";
import type { Strategy, StrategyContext } from "@dodash/strategies";

export const withConfidenceCalibration = (
  strategy: Strategy,
  profile: ConfidenceCalibrationProfile,
): Strategy =>
  Object.freeze({
    id: strategy.id,
    evaluate: (context: StrategyContext) => {
      if (!isConfidenceCalibrationProfile(profile)) {
        return err({
          code: "INVALID_STRATEGY_CONFIG" as const,
          strategyId: strategy.id,
        });
      }
      const evaluated = strategy.evaluate(context);
      if (!evaluated.ok || evaluated.value.side === "HOLD") return evaluated;

      const calibrated = calibrateConfidence(profile, evaluated.value.confidence);
      if (!calibrated.ok) {
        return err({
          code: "INVALID_STRATEGY_CONFIG" as const,
          strategyId: strategy.id,
        });
      }
      const signal = createSignal({
        ...evaluated.value,
        confidence: calibrated.value,
      });
      return signal.ok
        ? signal
        : err({
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: strategy.id,
            cause: signal.error,
          });
    },
  });
