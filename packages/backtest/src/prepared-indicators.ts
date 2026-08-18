import {
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type Result,
} from "@dodash/domain";
import {
  computeIndicators,
  IndicatorConfig,
  IndicatorError,
  IndicatorSnapshot,
} from "@dodash/indicators-prolog";

export interface PreparedBacktestIndicators {
  readonly config: IndicatorConfig;
  readonly snapshots: readonly (IndicatorSnapshot | null)[];
}

export type PreparedBacktestIndicatorsError =
  | { readonly code: "INVALID_PREPARED_CANDLES" }
  | { readonly code: "PREPARED_INDICATOR_FAILURE"; readonly cause: IndicatorError };

export const prepareBacktestIndicators = async (
  candles: readonly Candle[],
  config: IndicatorConfig,
): Promise<Result<PreparedBacktestIndicators, PreparedBacktestIndicatorsError>> => {
  const validated = validateCandleSeries(candles);
  if (!validated.ok) return err({ code: "INVALID_PREPARED_CANDLES" });
  const warmup = Math.max(
    config.rsiPeriod + 1,
    config.emaSlowPeriod,
    config.atrPeriod,
  );
  const snapshots: (IndicatorSnapshot | null)[] = validated.value.map(() => null);
  for (let index = warmup - 1; index < validated.value.length; index += 1) {
    const result = await computeIndicators(validated.value.slice(0, index + 1), config);
    if (!result.ok) {
      return err({ code: "PREPARED_INDICATOR_FAILURE", cause: result.error });
    }
    snapshots[index] = result.value;
  }
  return ok(
    Object.freeze({
      config: Object.freeze({ ...config }),
      snapshots: Object.freeze(snapshots),
    }),
  );
};
