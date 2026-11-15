import {
	type Candle,
	err,
	ok,
	type Result,
	validateCandleSeries,
} from "@dodash/domain";
import {
	createIndicatorSeriesComputer,
	type IndicatorConfig,
	type IndicatorError,
	type IndicatorSnapshot,
} from "@dodash/indicators-prolog";

export interface PreparedBacktestIndicators {
	readonly config: IndicatorConfig;
	readonly snapshots: readonly (IndicatorSnapshot | null)[];
}

export type PreparedBacktestIndicatorsError =
	| { readonly code: "INVALID_PREPARED_CANDLES" }
	| {
			readonly code: "PREPARED_INDICATOR_FAILURE";
			readonly cause: IndicatorError;
	  };

/**
 * Préparation incrémentale (DAO #37, models/backtest-run.md §Préparation
 * incrémentale, INV-27) : une session Prolog et un consult uniques,
 * accumulations poursuivies par les prédicats d'accumulation existants,
 * buts bornés identiques à l'implémentation de référence
 * (`computeIndicators` sur chaque préfixe) — snapshots strictement
 * identiques, `snapshotId` compris. La série est validée une fois en
 * amont ; l'échauffement (`requiredIndicatorCandles`) reste géré par le
 * computer.
 */
export const prepareBacktestIndicators = async (
	candles: readonly Candle[],
	config: IndicatorConfig,
): Promise<
	Result<PreparedBacktestIndicators, PreparedBacktestIndicatorsError>
> => {
	const validated = validateCandleSeries(candles);
	if (!validated.ok) return err({ code: "INVALID_PREPARED_CANDLES" });
	const computer = await createIndicatorSeriesComputer(config);
	if (!computer.ok) {
		return err({ code: "PREPARED_INDICATOR_FAILURE", cause: computer.error });
	}
	const snapshots: (IndicatorSnapshot | null)[] = [];
	for (const candle of validated.value) {
		const pushed = await computer.value.push(candle);
		if (!pushed.ok) {
			return err({ code: "PREPARED_INDICATOR_FAILURE", cause: pushed.error });
		}
		snapshots.push(pushed.value);
	}
	return ok(
		Object.freeze({
			config: Object.freeze({
				...config,
				returnPeriods: Object.freeze([...config.returnPeriods]),
			}),
			snapshots: Object.freeze(snapshots),
		}),
	);
};
