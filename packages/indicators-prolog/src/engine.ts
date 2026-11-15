import {
	type Candle,
	err,
	type MarketValidationError,
	ok,
	type Result,
	validateCandleSeries,
} from "@dodash/domain";
import pl from "tau-prolog";

import { PROLOG_SOURCE } from "./prolog-source.js";

export interface IndicatorConfig {
	readonly rsiPeriod: number;
	readonly emaFastPeriod: number;
	readonly emaSlowPeriod: number;
	readonly atrPeriod: number;
	readonly historicalVolatilityPeriod: number;
	readonly momentumPeriod: number;
	readonly returnPeriods: readonly number[];
	readonly vwapPeriod: number;
	readonly relativeVolumePeriod: number;
	readonly volumeSpikeThreshold: number;
	readonly volumeTrendPeriod: number;
	readonly trendStrengthPeriod: number;
	/**
	 * Paire d'EMAs de signal optionnelle (models/ema-signal-decoupling.md) :
	 * les deux champs présents ou aucun (INV-E2). Absente ⇒ comportement et
	 * requêtes Prolog strictement identiques à V1 (INV-E1).
	 */
	readonly signalEmaFastPeriod?: number;
	readonly signalEmaSlowPeriod?: number;
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = Object.freeze({
	rsiPeriod: 14,
	emaFastPeriod: 12,
	emaSlowPeriod: 26,
	atrPeriod: 14,
	historicalVolatilityPeriod: 20,
	momentumPeriod: 10,
	returnPeriods: Object.freeze([1, 5, 20]),
	vwapPeriod: 20,
	relativeVolumePeriod: 20,
	volumeSpikeThreshold: 2,
	volumeTrendPeriod: 20,
	trendStrengthPeriod: 14,
});

/**
 * Période figée du funding moyen glissant (models/funding-rate-strategy.md
 * §4) : source unique, consommée par la couture runtime et le backtest.
 * Figée a priori, tout balayage exclu.
 */
export const FUNDING_AVG_PERIOD = 72;

export interface TradeSample {
	readonly price: number;
	readonly size: number;
}

export interface OrderBookLevel {
	readonly price: number;
	readonly size: number;
}

export interface OrderBookSnapshot {
	readonly bids: readonly OrderBookLevel[];
	readonly asks: readonly OrderBookLevel[];
}

export interface IndicatorMicrostructure {
	readonly trades?: readonly TradeSample[];
	readonly orderBook?: OrderBookSnapshot;
}

/**
 * Entrée funding optionnelle (models/funding-rate-strategy.md §4) : taux
 * alignés par SUFFIXE sur les dernières `rates.length` bougies de la
 * série passée, période glissante explicite. Absente ⇒ aucune requête
 * Prolog additionnelle, snapshot bit-identique (INV-F1).
 */
export interface IndicatorFunding {
	readonly rates: readonly number[];
	readonly avgPeriod: number;
}

export interface OrderBookVwap {
	readonly bid: number;
	readonly ask: number;
	readonly mid: number;
}

export interface BidAskSpread {
	readonly absolute: number;
	readonly bps: number;
}

export interface IndicatorSnapshot {
	readonly snapshotId: string;
	readonly candleClosedAt: number;
	readonly rsi: number;
	readonly emaFast: number;
	readonly emaSlow: number;
	/**
	 * EMAs de signal (models/ema-signal-decoupling.md INV-E1) : absentes du
	 * snapshot tant que la paire n'est pas configurée — le snapshot reste
	 * identique à V1 ; présentes avec la convention `?? 0` sinon.
	 */
	readonly signalEmaFast?: number;
	readonly signalEmaSlow?: number;
	readonly macd: number;
	readonly atr: number;
	readonly historicalVolatility: number;
	readonly momentum: number;
	readonly periodicReturns: Readonly<Record<string, number>>;
	readonly ohlcvVwap: number | null;
	readonly tradeVwap: number | null;
	readonly orderBookVwap: OrderBookVwap | null;
	readonly bidAskSpread: BidAskSpread | null;
	readonly relativeVolume: number | null;
	readonly volumeSpike: boolean | null;
	readonly volumeTrend: number | null;
	readonly vwapDeviation: number | null;
	readonly trendStrength: number;
	/**
	 * Funding moyen glissant (models/funding-rate-strategy.md) : absent du
	 * snapshot tant qu'aucune entrée funding n'est fournie (INV-F1) ou
	 * pendant l'échauffement (rates.length < avgPeriod, INV-F3).
	 */
	readonly fundingAvg?: number;
}

export type IndicatorError =
	| { readonly code: "INVALID_CANDLES"; readonly cause: MarketValidationError }
	| { readonly code: "INVALID_CONFIG" }
	| { readonly code: "INVALID_FUNDING_DATA" }
	| { readonly code: "INVALID_MICROSTRUCTURE" }
	| {
			readonly code: "INSUFFICIENT_CANDLES";
			readonly required: number;
			readonly actual: number;
	  }
	| { readonly code: "PROLOG_PARSE_ERROR" }
	| { readonly code: "PROLOG_QUERY_ERROR"; readonly indicator: string }
	| { readonly code: "PROLOG_QUERY_FAILED"; readonly indicator: string }
	| { readonly code: "PROLOG_LIMIT_EXCEEDED"; readonly indicator: string }
	| { readonly code: "NON_NUMERIC_RESULT"; readonly indicator: string };

type Session = ReturnType<typeof pl.create>;

const consult = (session: Session): Promise<Result<void, IndicatorError>> =>
	new Promise((resolve) => {
		session.consult(PROLOG_SOURCE, {
			success: () => resolve(ok(undefined)),
			error: () => resolve(err({ code: "PROLOG_PARSE_ERROR" })),
		});
	});

const parseAnswer = (formatted: string, variable: string): number | null => {
	const match = formatted.match(
		new RegExp(
			`${variable}\\s*=\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)`,
			"i",
		),
	);
	if (match?.[1] === undefined) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
};

const queryNumbers = (
	session: Session,
	indicator: string,
	goal: string,
	variables: readonly string[],
): Promise<Result<Readonly<Record<string, number>>, IndicatorError>> =>
	new Promise((resolve) => {
		session.query(goal, {
			success: () => {
				session.answer({
					success: (answer) => {
						const formatted = session.format_answer(answer);
						const values: Record<string, number> = {};
						for (const variable of variables) {
							const value = parseAnswer(formatted, variable);
							if (value === null) {
								resolve(err({ code: "NON_NUMERIC_RESULT", indicator }));
								return;
							}
							values[variable] = value;
						}
						resolve(ok(Object.freeze(values)));
					},
					error: () => resolve(err({ code: "PROLOG_QUERY_ERROR", indicator })),
					fail: () => resolve(err({ code: "PROLOG_QUERY_FAILED", indicator })),
					limit: () =>
						resolve(err({ code: "PROLOG_LIMIT_EXCEEDED", indicator })),
				});
			},
			error: () => resolve(err({ code: "PROLOG_QUERY_ERROR", indicator })),
		});
	});

const queryNumber = async (
	session: Session,
	indicator: string,
	goal: string,
): Promise<Result<number, IndicatorError>> => {
	const result = await queryNumbers(session, indicator, goal, ["Value"]);
	return result.ok ? ok(result.value.Value ?? 0) : result;
};

const asPrologList = (values: readonly number[]): string =>
	`[${values.map((value) => String(value)).join(",")}]`;

const validPeriod = (value: number): boolean =>
	Number.isSafeInteger(value) && value > 0;

const validReturnPeriods = (periods: readonly number[]): boolean =>
	Array.isArray(periods) &&
	periods.length > 0 &&
	periods.every(
		(period, index) =>
			validPeriod(period) &&
			(index === 0 || period > (periods[index - 1] ?? 0)),
	);

const validConfig = (config: IndicatorConfig): boolean =>
	validPeriod(config.rsiPeriod) &&
	validPeriod(config.emaFastPeriod) &&
	validPeriod(config.emaSlowPeriod) &&
	validPeriod(config.atrPeriod) &&
	validPeriod(config.historicalVolatilityPeriod) &&
	config.historicalVolatilityPeriod >= 2 &&
	validPeriod(config.momentumPeriod) &&
	validReturnPeriods(config.returnPeriods) &&
	validPeriod(config.vwapPeriod) &&
	validPeriod(config.relativeVolumePeriod) &&
	Number.isFinite(config.volumeSpikeThreshold) &&
	config.volumeSpikeThreshold > 0 &&
	validPeriod(config.volumeTrendPeriod) &&
	config.volumeTrendPeriod >= 2 &&
	validPeriod(config.trendStrengthPeriod) &&
	config.emaFastPeriod < config.emaSlowPeriod &&
	// INV-E2 (models/ema-signal-decoupling.md) : couplage strict, fail-closed.
	((config.signalEmaFastPeriod === undefined &&
		config.signalEmaSlowPeriod === undefined) ||
		(config.signalEmaFastPeriod !== undefined &&
			config.signalEmaSlowPeriod !== undefined &&
			validPeriod(config.signalEmaFastPeriod) &&
			validPeriod(config.signalEmaSlowPeriod) &&
			config.signalEmaFastPeriod < config.signalEmaSlowPeriod));

export const requiredIndicatorCandles = (config: IndicatorConfig): number =>
	Math.max(
		config.rsiPeriod + 1,
		config.emaSlowPeriod,
		// INV-E2 : le warm-up couvre la paire de signal quand elle est présente.
		config.signalEmaSlowPeriod ?? 0,
		config.atrPeriod,
		config.historicalVolatilityPeriod + 1,
		config.momentumPeriod + 1,
		(config.returnPeriods.at(-1) ?? 0) + 1,
		config.vwapPeriod,
		config.relativeVolumePeriod + 1,
		config.volumeTrendPeriod,
		config.trendStrengthPeriod * 2,
	);

const isPositiveFinite = (value: number): boolean =>
	Number.isFinite(value) && value > 0;

/**
 * Nombre injecté dans un but Prolog : même sérialisation que les listes
 * (`asPrologList`), parenthésé pour tolérer les valeurs négatives.
 */
const asPrologNumber = (value: number): string => `(${String(value)})`;

interface BoundedIndicatorFields {
	readonly periodicReturns: Readonly<Record<string, number>>;
	readonly ohlcvVwap: number | null;
	readonly relativeVolume: number | null;
	readonly volumeSpike: boolean | null;
	readonly volumeTrend: number | null;
	readonly vwapDeviation: number | null;
}

/**
 * Buts à fenêtre glissante bornée (DAO #37) : partagés par
 * `computeIndicators` (référence) et le computer incrémental — les mêmes
 * chaînes de buts sur les mêmes fenêtres garantissent les mêmes valeurs.
 * Mutabiliste par performance : `candleValues` est rempli in place avec
 * les indicateurs bornés (Rsi, HistoricalVolatility, Momentum,
 * TrendStrength).
 */
const evaluateBoundedIndicators = async (
	session: Session,
	candles: readonly Candle[],
	config: IndicatorConfig,
	candleValues: Record<string, number>,
): Promise<Result<BoundedIndicatorFields, IndicatorError>> => {
	const closeValues = candles.map((candle) => candle.close);
	const highValues = candles.map((candle) => candle.high);
	const lowValues = candles.map((candle) => candle.low);
	const volumeValues = candles.map((candle) => candle.volume);
	const last = candles.at(-1);
	if (last === undefined) {
		return err({
			code: "INSUFFICIENT_CANDLES",
			required: 1,
			actual: candles.length,
		});
	}
	const fixedWindowList = (values: readonly number[], length: number): string =>
		asPrologList(values.slice(-length));
	const boundedGoals: readonly (readonly [string, string])[] = [
		[
			"Rsi",
			`rsi(${fixedWindowList(closeValues, config.rsiPeriod + 1)}, ${config.rsiPeriod}, Value).`,
		],
		[
			"HistoricalVolatility",
			`historical_volatility(${fixedWindowList(closeValues, config.historicalVolatilityPeriod + 1)}, ${config.historicalVolatilityPeriod}, Value).`,
		],
		[
			"Momentum",
			`momentum(${fixedWindowList(closeValues, config.momentumPeriod + 1)}, ${config.momentumPeriod}, Value).`,
		],
		[
			"TrendStrength",
			`trend_strength(${fixedWindowList(highValues, config.trendStrengthPeriod * 2)}, ${fixedWindowList(lowValues, config.trendStrengthPeriod * 2)}, ${fixedWindowList(closeValues, config.trendStrengthPeriod * 2)}, ${config.trendStrengthPeriod}, Value).`,
		],
	];
	for (const [indicator, goal] of boundedGoals) {
		const result = await queryNumber(session, indicator, goal);
		if (!result.ok) return result;
		candleValues[indicator] = result.value;
	}

	const periodicReturns: Record<string, number> = {};
	for (const period of config.returnPeriods) {
		const result = await queryNumber(
			session,
			`periodic-return-${period}`,
			`periodic_return(${fixedWindowList(closeValues, period + 1)}, ${period}, Value).`,
		);
		if (!result.ok) return result;
		periodicReturns[String(period)] = result.value;
	}

	const vwapVolume = candles
		.slice(-config.vwapPeriod)
		.reduce((sum, candle) => sum + candle.volume, 0);
	const hasOhlcvVwap = vwapVolume > 0;
	let ohlcvVwap: number | null = null;
	let vwapDeviation: number | null = null;
	if (hasOhlcvVwap) {
		const vwap = await queryNumber(
			session,
			"ohlcv-vwap",
			`ohlcv_vwap(${fixedWindowList(highValues, config.vwapPeriod)}, ${fixedWindowList(lowValues, config.vwapPeriod)}, ${fixedWindowList(closeValues, config.vwapPeriod)}, ${fixedWindowList(volumeValues, config.vwapPeriod)}, ${config.vwapPeriod}, Value).`,
		);
		if (!vwap.ok) return vwap;
		ohlcvVwap = vwap.value;
		const deviation = await queryNumber(
			session,
			"vwap-deviation",
			`vwap_deviation(${last.close}, ${vwap.value}, Value).`,
		);
		if (!deviation.ok) return deviation;
		vwapDeviation = deviation.value;
	}

	const relativeVolumeReference = candles
		.slice(-(config.relativeVolumePeriod + 1), -1)
		.reduce((sum, candle) => sum + candle.volume, 0);
	const hasRelativeVolume = relativeVolumeReference > 0;
	let relativeVolume: number | null = null;
	let volumeSpike: boolean | null = null;
	if (hasRelativeVolume) {
		const relative = await queryNumber(
			session,
			"relative-volume",
			`relative_volume(${fixedWindowList(volumeValues, config.relativeVolumePeriod + 1)}, ${config.relativeVolumePeriod}, Value).`,
		);
		if (!relative.ok) return relative;
		relativeVolume = relative.value;
		const spike = await queryNumber(
			session,
			"volume-spike",
			`volume_spike(${relative.value}, ${config.volumeSpikeThreshold}, Value).`,
		);
		if (!spike.ok) return spike;
		volumeSpike = spike.value === 1;
	}

	const volumeTrendSum = candles
		.slice(-config.volumeTrendPeriod)
		.reduce((sum, candle) => sum + candle.volume, 0);
	const hasVolumeTrend = volumeTrendSum > 0;
	let volumeTrend: number | null = null;
	if (hasVolumeTrend) {
		const trend = await queryNumber(
			session,
			"volume-trend",
			`volume_trend(${fixedWindowList(volumeValues, config.volumeTrendPeriod)}, ${config.volumeTrendPeriod}, Value).`,
		);
		if (!trend.ok) return trend;
		volumeTrend = trend.value;
	}

	return ok(
		Object.freeze({
			periodicReturns: Object.freeze(periodicReturns),
			ohlcvVwap,
			relativeVolume,
			volumeSpike,
			volumeTrend,
			vwapDeviation,
		}),
	);
};

/**
 * Computer incrémental d'une série de snapshots (DAO #37,
 * models/backtest-run.md §Préparation incrémentale, INV-27) : une session
 * Prolog et un consult uniques, accumulations poursuivies par les
 * prédicats d'accumulation existants (`ema_acc`, `atr_continue`, `is/2`
 * pour la soustraction MACD) — la continuation applique au seul suffixe
 * nouveau la même chaîne d'opérations flottantes que le fold complet, donc
 * des valeurs bit-identiques. Les buts à fenêtre glissante bornée restent
 * réévalués par bougie avec les buts de référence. Microstructure et
 * funding exclus : ce computer ne sert que la préparation backtest
 * ( snapshots identiques à `computeIndicators(candles, config)`).
 * Précondition : les bougies poussées forment une série validée
 * (`validateCandleSeries`) — `prepareBacktestIndicators` la valide en amont.
 */
export interface IndicatorSeriesComputer {
	/**
	 * Pousse la bougie suivante de la série. Rend `null` pendant
	 * l'échauffement (avant `requiredIndicatorCandles(config) - 1`).
	 */
	readonly push: (
		candle: Candle,
	) => Promise<Result<IndicatorSnapshot | null, IndicatorError>>;
}

interface FoldAccumulators {
	emaFast: number;
	emaSlow: number;
	atr: number;
	previousClose: number;
	signalEmaFast?: number;
	signalEmaSlow?: number;
}

export const createIndicatorSeriesComputer = async (
	config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
): Promise<Result<IndicatorSeriesComputer, IndicatorError>> => {
	if (!validConfig(config)) {
		return err({ code: "INVALID_CONFIG" });
	}
	const session = pl.create(1_000_000);
	const consulted = await consult(session);
	if (!consulted.ok) return consulted;
	const warmup = requiredIndicatorCandles(config);
	const signalEmaActive =
		config.signalEmaFastPeriod !== undefined &&
		config.signalEmaSlowPeriod !== undefined;
	const candles: Candle[] = [];
	let folds: FoldAccumulators | null = null;

	const continueFold = async (
		indicator: string,
		goal: string,
	): Promise<Result<number, IndicatorError>> =>
		queryNumber(session, indicator, goal);

	const push = async (
		candle: Candle,
	): Promise<Result<IndicatorSnapshot | null, IndicatorError>> => {
		candles.push(candle);
		const candleCount = candles.length;
		if (candleCount < warmup) return ok(null);

		const closeValues = candles.map((entry) => entry.close);
		const highValues = candles.map((entry) => entry.high);
		const lowValues = candles.map((entry) => entry.low);
		const last = candles.at(-1);
		if (last === undefined) {
			return err({ code: "INSUFFICIENT_CANDLES", required: warmup, actual: 0 });
		}
		const candleValues: Record<string, number> = {};

		if (candleCount === warmup) {
			// Amorçage : plis complets sur le préfixe d'échauffement, buts
			// identiques à computeIndicators.
			const closes = asPrologList(closeValues);
			const highs = asPrologList(highValues);
			const lows = asPrologList(lowValues);
			const seedGoals: readonly (readonly [string, string])[] = [
				["EmaFast", `ema(${closes}, ${config.emaFastPeriod}, Value).`],
				["EmaSlow", `ema(${closes}, ${config.emaSlowPeriod}, Value).`],
				[
					"Atr",
					`atr(${highs}, ${lows}, ${closes}, ${config.atrPeriod}, Value).`,
				],
				...(signalEmaActive
					? ([
							[
								"SignalEmaFast",
								`ema(${closes}, ${config.signalEmaFastPeriod}, Value).`,
							],
							[
								"SignalEmaSlow",
								`ema(${closes}, ${config.signalEmaSlowPeriod}, Value).`,
							],
						] as const)
					: []),
			];
			for (const [indicator, goal] of seedGoals) {
				const result = await continueFold(indicator, goal);
				if (!result.ok) return result;
				candleValues[indicator] = result.value;
			}
			const seedEmaFast = candleValues.EmaFast;
			const seedEmaSlow = candleValues.EmaSlow;
			const seedAtr = candleValues.Atr;
			if (
				seedEmaFast === undefined ||
				seedEmaSlow === undefined ||
				seedAtr === undefined
			) {
				return err({ code: "PROLOG_QUERY_FAILED", indicator: "seed" });
			}
			// Macd = EmaFast − EmaSlow via is/2 : mêmes opérandes et même
			// soustraction que macd/4 (ema(Closes,F) − ema(Closes,S)) → bit-exact.
			const macdSeed = await continueFold(
				"Macd",
				`Value is ${asPrologNumber(seedEmaFast)} - ${asPrologNumber(seedEmaSlow)}.`,
			);
			if (!macdSeed.ok) return macdSeed;
			candleValues.Macd = macdSeed.value;
			folds = {
				emaFast: seedEmaFast,
				emaSlow: seedEmaSlow,
				atr: seedAtr,
				// État de atr_continue après le fold complet : PreviousClose est la
				// clôture de la dernière bougie consommée (le fold passe Close au
				// recursive call), i.e. la dernière bougie du préfixe.
				previousClose: last.close,
				...(signalEmaActive
					? {
							signalEmaFast: candleValues.SignalEmaFast ?? 0,
							signalEmaSlow: candleValues.SignalEmaSlow ?? 0,
						}
					: {}),
			};
		} else if (folds !== null) {
			// Continuation : mêmes prédicats d'accumulation que le pli complet,
			// appliqués au seul suffixe nouveau (bit-exact par construction).
			const alphaGoal = (period: number): string =>
				`Alpha is 2 / (${period} + 1)`;
			const emaFastGoal = `(${alphaGoal(config.emaFastPeriod)}), ema_acc([${last.close}], Alpha, ${asPrologNumber(folds.emaFast)}, Value).`;
			const emaSlowGoal = `(${alphaGoal(config.emaSlowPeriod)}), ema_acc([${last.close}], Alpha, ${asPrologNumber(folds.emaSlow)}, Value).`;
			const atrGoal = `atr_continue([${last.high}], [${last.low}], [${last.close}], ${asPrologNumber(folds.previousClose)}, ${config.atrPeriod}, ${asPrologNumber(folds.atr)}, Value).`;
			const emaFastResult = await continueFold("EmaFast", emaFastGoal);
			if (!emaFastResult.ok) return emaFastResult;
			const emaSlowResult = await continueFold("EmaSlow", emaSlowGoal);
			if (!emaSlowResult.ok) return emaSlowResult;
			const atrResult = await continueFold("Atr", atrGoal);
			if (!atrResult.ok) return atrResult;
			candleValues.EmaFast = emaFastResult.value;
			candleValues.EmaSlow = emaSlowResult.value;
			candleValues.Atr = atrResult.value;
			const macdResult = await continueFold(
				"Macd",
				`Value is ${asPrologNumber(emaFastResult.value)} - ${asPrologNumber(emaSlowResult.value)}.`,
			);
			if (!macdResult.ok) return macdResult;
			candleValues.Macd = macdResult.value;
			const nextFolds: FoldAccumulators = {
				emaFast: emaFastResult.value,
				emaSlow: emaSlowResult.value,
				atr: atrResult.value,
				previousClose: last.close,
			};
			if (
				signalEmaActive &&
				folds.signalEmaFast !== undefined &&
				folds.signalEmaSlow !== undefined
			) {
				const signalFastGoal = `(${alphaGoal(config.signalEmaFastPeriod ?? 0)}), ema_acc([${last.close}], Alpha, ${asPrologNumber(folds.signalEmaFast)}, Value).`;
				const signalSlowGoal = `(${alphaGoal(config.signalEmaSlowPeriod ?? 0)}), ema_acc([${last.close}], Alpha, ${asPrologNumber(folds.signalEmaSlow)}, Value).`;
				const signalFastResult = await continueFold(
					"SignalEmaFast",
					signalFastGoal,
				);
				if (!signalFastResult.ok) return signalFastResult;
				const signalSlowResult = await continueFold(
					"SignalEmaSlow",
					signalSlowGoal,
				);
				if (!signalSlowResult.ok) return signalSlowResult;
				candleValues.SignalEmaFast = signalFastResult.value;
				candleValues.SignalEmaSlow = signalSlowResult.value;
				nextFolds.signalEmaFast = signalFastResult.value;
				nextFolds.signalEmaSlow = signalSlowResult.value;
			}
			folds = nextFolds;
		} else {
			return err({
				code: "INSUFFICIENT_CANDLES",
				required: warmup,
				actual: candleCount,
			});
		}

		const bounded = await evaluateBoundedIndicators(
			session,
			candles,
			config,
			candleValues,
		);
		if (!bounded.ok) return bounded;

		const snapshotId = hashSnapshot(
			JSON.stringify({ candles, config, microstructure: null }),
		);
		return ok(
			Object.freeze({
				snapshotId,
				candleClosedAt: last.start,
				rsi: candleValues.Rsi ?? 0,
				emaFast: candleValues.EmaFast ?? 0,
				emaSlow: candleValues.EmaSlow ?? 0,
				...(signalEmaActive
					? {
							signalEmaFast: candleValues.SignalEmaFast ?? 0,
							signalEmaSlow: candleValues.SignalEmaSlow ?? 0,
						}
					: {}),
				macd: candleValues.Macd ?? 0,
				atr: candleValues.Atr ?? 0,
				historicalVolatility: candleValues.HistoricalVolatility ?? 0,
				momentum: candleValues.Momentum ?? 0,
				periodicReturns: bounded.value.periodicReturns,
				ohlcvVwap: bounded.value.ohlcvVwap,
				tradeVwap: null,
				orderBookVwap: null,
				bidAskSpread: null,
				relativeVolume: bounded.value.relativeVolume,
				volumeSpike: bounded.value.volumeSpike,
				volumeTrend: bounded.value.volumeTrend,
				vwapDeviation: bounded.value.vwapDeviation,
				trendStrength: candleValues.TrendStrength ?? 0,
			}),
		);
	};

	return ok(Object.freeze({ push }));
};

/**
 * Validation funding fail-closed (INV-F2) : alignement SUFFIXE — `rates`
 * couvre les dernières `rates.length` bougies, d'où `rates.length ≤
 * candleCount` (amendement C1-suite, models/funding-rate-strategy.md
 * §4) ; taux tous finis, période entière ≥ 2.
 */
const validFunding = (
	funding: IndicatorFunding,
	candleCount: number,
): boolean =>
	Number.isSafeInteger(funding.avgPeriod) &&
	funding.avgPeriod >= 2 &&
	Array.isArray(funding.rates) &&
	funding.rates.length <= candleCount &&
	funding.rates.every((rate) => Number.isFinite(rate));

const validMicrostructure = (
	microstructure: IndicatorMicrostructure | undefined,
): boolean => {
	if (microstructure === undefined) return true;
	if (
		microstructure.trades !== undefined &&
		(!Array.isArray(microstructure.trades) ||
			!microstructure.trades.every(
				(trade) =>
					isPositiveFinite(trade.price) && isPositiveFinite(trade.size),
			))
	) {
		return false;
	}
	const book = microstructure.orderBook;
	if (book === undefined) return true;
	if (
		!Array.isArray(book.bids) ||
		!Array.isArray(book.asks) ||
		![...book.bids, ...book.asks].every(
			(level) => isPositiveFinite(level.price) && isPositiveFinite(level.size),
		)
	) {
		return false;
	}
	if (book.bids.length === 0 || book.asks.length === 0) return true;
	const bestBid = Math.max(...book.bids.map((level) => level.price));
	const bestAsk = Math.min(...book.asks.map((level) => level.price));
	return bestBid <= bestAsk;
};

const hashSnapshot = (source: string): string => {
	let hash = 0x811c9dc5;
	for (let index = 0; index < source.length; index += 1) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `ind-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export const computeIndicators = async (
	candles: readonly Candle[],
	config: IndicatorConfig = DEFAULT_INDICATOR_CONFIG,
	microstructure?: IndicatorMicrostructure,
	funding?: IndicatorFunding,
): Promise<Result<IndicatorSnapshot, IndicatorError>> => {
	const validated = validateCandleSeries(candles);
	if (!validated.ok) {
		return err({ code: "INVALID_CANDLES", cause: validated.error });
	}

	if (!validConfig(config)) {
		return err({ code: "INVALID_CONFIG" });
	}
	if (!validMicrostructure(microstructure)) {
		return err({ code: "INVALID_MICROSTRUCTURE" });
	}
	if (funding !== undefined && !validFunding(funding, validated.value.length)) {
		return err({ code: "INVALID_FUNDING_DATA" });
	}

	const required = requiredIndicatorCandles(config);
	if (validated.value.length < required) {
		return err({
			code: "INSUFFICIENT_CANDLES",
			required,
			actual: validated.value.length,
		});
	}

	const session = pl.create(1_000_000);
	const consulted = await consult(session);
	if (!consulted.ok) return consulted;

	const last = validated.value.at(-1);
	if (last === undefined) {
		return err({ code: "INSUFFICIENT_CANDLES", required, actual: 0 });
	}
	const closeValues = validated.value.map((candle) => candle.close);
	const highValues = validated.value.map((candle) => candle.high);
	const lowValues = validated.value.map((candle) => candle.low);
	const candleValues: Record<string, number> = {};
	// INV-E1 : paire absente ⇒ aucune requête Prolog additionnelle.
	const signalEmaActive =
		config.signalEmaFastPeriod !== undefined &&
		config.signalEmaSlowPeriod !== undefined;
	const closes = asPrologList(closeValues);
	const highs = asPrologList(highValues);
	const lows = asPrologList(lowValues);
	const foldGoals: readonly (readonly [string, string])[] = [
		["EmaFast", `ema(${closes}, ${config.emaFastPeriod}, Value).`],
		["EmaSlow", `ema(${closes}, ${config.emaSlowPeriod}, Value).`],
		[
			"Macd",
			`macd(${closes}, ${config.emaFastPeriod}, ${config.emaSlowPeriod}, Value).`,
		],
		["Atr", `atr(${highs}, ${lows}, ${closes}, ${config.atrPeriod}, Value).`],
		...(signalEmaActive
			? ([
					[
						"SignalEmaFast",
						`ema(${closes}, ${config.signalEmaFastPeriod}, Value).`,
					],
					[
						"SignalEmaSlow",
						`ema(${closes}, ${config.signalEmaSlowPeriod}, Value).`,
					],
				] as const)
			: []),
	];
	for (const [indicator, goal] of foldGoals) {
		const result = await queryNumber(session, indicator, goal);
		if (!result.ok) return result;
		candleValues[indicator] = result.value;
	}

	// INV-F1 : aucune entrée funding ⇒ aucune requête Prolog additionnelle.
	// INV-F3 : échauffement (longueur < période) ⇒ champ absent du snapshot.
	const fundingReady =
		funding !== undefined && funding.rates.length >= funding.avgPeriod;
	if (fundingReady) {
		const fundingResult = await queryNumber(
			session,
			"funding-average",
			`funding_average(${asPrologList(funding.rates)}, ${funding.avgPeriod}, Value).`,
		);
		if (!fundingResult.ok) return fundingResult;
		candleValues.FundingAvg = fundingResult.value;
	}

	// Buts à fenêtre glissante bornée, partagés avec le computer incrémental
	// (DAO #37) : mêmes chaînes de buts ⇒ mêmes valeurs.
	const bounded = await evaluateBoundedIndicators(
		session,
		validated.value,
		config,
		candleValues,
	);
	if (!bounded.ok) return bounded;

	let tradeVwap: number | null = null;
	let orderBookVwap: OrderBookVwap | null = null;
	let bidAskSpread: BidAskSpread | null = null;
	const microGoals: string[] = [];
	const microVariables: string[] = [];
	const trades = microstructure?.trades ?? [];
	if (trades.length > 0) {
		microVariables.push("TradeVwap");
		microGoals.push(
			`weighted_vwap(${asPrologList(trades.map((trade) => trade.price))}, ${asPrologList(trades.map((trade) => trade.size))}, TradeVwap)`,
		);
	}
	const book = microstructure?.orderBook;
	if (book !== undefined && book.bids.length > 0 && book.asks.length > 0) {
		const bidPrices = asPrologList(book.bids.map((level) => level.price));
		const bidSizes = asPrologList(book.bids.map((level) => level.size));
		const askPrices = asPrologList(book.asks.map((level) => level.price));
		const askSizes = asPrologList(book.asks.map((level) => level.size));
		microVariables.push(
			"BookBidVwap",
			"BookAskVwap",
			"BookMidVwap",
			"SpreadAbsolute",
			"SpreadBps",
		);
		microGoals.push(
			`weighted_vwap(${bidPrices}, ${bidSizes}, BookBidVwap)`,
			`weighted_vwap(${askPrices}, ${askSizes}, BookAskVwap)`,
			"midpoint(BookBidVwap, BookAskVwap, BookMidVwap)",
			`spread_absolute(${bidPrices}, ${askPrices}, SpreadAbsolute)`,
			`spread_bps(${bidPrices}, ${askPrices}, SpreadBps)`,
		);
	}
	if (microGoals.length > 0) {
		const microValues = await queryNumbers(
			session,
			"microstructure-indicators",
			`${microGoals.join(", ")}.`,
			microVariables,
		);
		if (!microValues.ok) return microValues;
		tradeVwap = microValues.value.TradeVwap ?? null;
		if (book !== undefined && book.bids.length > 0 && book.asks.length > 0) {
			orderBookVwap = Object.freeze({
				bid: microValues.value.BookBidVwap ?? 0,
				ask: microValues.value.BookAskVwap ?? 0,
				mid: microValues.value.BookMidVwap ?? 0,
			});
			bidAskSpread = Object.freeze({
				absolute: microValues.value.SpreadAbsolute ?? 0,
				bps: microValues.value.SpreadBps ?? 0,
			});
		}
	}

	const snapshotId = hashSnapshot(
		JSON.stringify({
			candles: validated.value,
			config,
			microstructure: microstructure ?? null,
		}),
	);
	return ok(
		Object.freeze({
			snapshotId,
			candleClosedAt: last.start,
			rsi: candleValues.Rsi ?? 0,
			emaFast: candleValues.EmaFast ?? 0,
			emaSlow: candleValues.EmaSlow ?? 0,
			// INV-E1 : clés absentes du snapshot tant que la paire n'est pas
			// configurée — représentation et requêtes identiques à V1.
			...(signalEmaActive
				? {
						signalEmaFast: candleValues.SignalEmaFast ?? 0,
						signalEmaSlow: candleValues.SignalEmaSlow ?? 0,
					}
				: {}),
			macd: candleValues.Macd ?? 0,
			atr: candleValues.Atr ?? 0,
			historicalVolatility: candleValues.HistoricalVolatility ?? 0,
			momentum: candleValues.Momentum ?? 0,
			periodicReturns: bounded.value.periodicReturns,
			ohlcvVwap: bounded.value.ohlcvVwap,
			tradeVwap,
			orderBookVwap,
			bidAskSpread,
			relativeVolume: bounded.value.relativeVolume,
			volumeSpike: bounded.value.volumeSpike,
			volumeTrend: bounded.value.volumeTrend,
			vwapDeviation: bounded.value.vwapDeviation,
			trendStrength: candleValues.TrendStrength ?? 0,
			...(fundingReady ? { fundingAvg: candleValues.FundingAvg } : {}),
		}),
	);
};
