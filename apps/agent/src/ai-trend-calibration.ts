/**
 * Trend-signal calibration join (models/ai-trend-signal.md §8).
 *
 * Pure join between persisted `ai_trend_signals` rows and the realized
 * closes: outcome at horizon h is `close(candle closing at C + h·D)`
 * compared to `close(candle closing at C)` (the last close of the signal's
 * state). An outcome whose candle is not closed yet — or absent from the
 * fetched window — is `PENDING` and never enters the ECE (INV 13).
 */

import {
	type Candle,
	TIMEFRAME_MILLISECONDS,
	type Timeframe,
} from "@dodash/domain";
import {
	type AiTrendBias,
	resolveVolScaledOutcome,
	type TrendOutcome,
} from "@dodash/models";
import type { AiTrendCollection } from "./ai-trend-producer.js";

export interface TrendSignalRow {
	readonly productId: string;
	readonly candleClosedAt: number;
	readonly observedAt: number;
	readonly bias: AiTrendBias;
	readonly probability: number;
	readonly collection: AiTrendCollection;
	readonly questionVersion: string;
	readonly thresholdBps: number | null;
}

export interface TrendOutcomeRow extends TrendSignalRow {
	readonly outcome: TrendOutcome;
}

const closeAt = (candles: readonly Candle[], start: number): number | null => {
	for (const candle of candles) {
		if (candle.start === start) {
			return candle.close;
		}
	}
	return null;
};

/** Pure: joins one product's signal rows with realized outcomes at horizon `h`. */
export const resolveTrendOutcomes = (
	rows: readonly TrendSignalRow[],
	candles: readonly Candle[],
	timeframeMs: number,
	horizon: number,
	now: number,
): readonly TrendOutcomeRow[] =>
	rows.map((row) => {
		const referenceClose = closeAt(candles, row.candleClosedAt - timeframeMs);
		const outcomeClose = closeAt(
			candles,
			row.candleClosedAt + (horizon - 1) * timeframeMs,
		);
		const outcomeClosedAt = row.candleClosedAt + horizon * timeframeMs;
		if (
			referenceClose === null ||
			outcomeClose === null ||
			outcomeClosedAt > now
		) {
			return { ...row, outcome: "PENDING" };
		}
		// v1 : θ = 0 (égalité stricte → FLAT) ; v2 : θ persisté à la production (INV 16).
		const outcome = resolveVolScaledOutcome(
			referenceClose,
			outcomeClose,
			row.thresholdBps ?? 0,
		);
		return { ...row, outcome: outcome ?? "PENDING" };
	});

export type CalibrationCollection = AiTrendCollection | "ALL";

export interface CalibrationQuery {
	readonly from: number;
	readonly to: number;
	readonly collection: CalibrationCollection;
	readonly horizon: number;
	readonly timeframe: Timeframe;
	readonly timeframeMs: number;
}

export type CalibrationQueryResult =
	| { readonly ok: true; readonly query: CalibrationQuery }
	| {
			readonly ok: false;
			readonly code: "INVALID_REQUEST" | "WINDOW_TOO_LARGE" | "INVALID_HORIZON";
	  };

/** Fenêtre bornée à 288 bougies + créneau ; horizon 1..24. */
export const AI_TREND_CALIBRATION_MAX_CANDLES = 288;

/** Limite prudente par fetch marché (le service plafonne à 300). */
export const AI_TREND_OUTCOME_FETCH_CANDLES = 290;

/**
 * Découpe la fenêtre d'issues [from, to + h·D] en fetchs ≤ 290 bougies —
 * la limite 288 + horizon + 2 dépassait 300 et tronquait les issues de
 * queue en PENDING (constat 2026-10-30).
 */
export const planOutcomeFetchWindows = (
	from: number,
	to: number,
	timeframeMs: number,
	horizon: number,
): readonly { readonly endMs: number; readonly limit: number }[] => {
	const lastOutcomeStart = to + (horizon - 1) * timeframeMs;
	const windows: { endMs: number; limit: number }[] = [];
	let end = lastOutcomeStart;
	while (end >= from - timeframeMs) {
		const span = Math.min(
			AI_TREND_OUTCOME_FETCH_CANDLES,
			Math.floor((end - (from - 2 * timeframeMs)) / timeframeMs) + 1,
		);
		if (span <= 0) break;
		windows.push({ endMs: end, limit: span });
		end -= (span - 1) * timeframeMs;
	}
	return Object.freeze(windows.reverse());
};

export const parseCalibrationQuery = (input: {
	from?: string | null;
	to?: string | null;
	collection?: string | null;
	horizon?: string | null;
	timeframe?: string | null;
}): CalibrationQueryResult => {
	const from = Number(input.from);
	const to = Number(input.to);
	const horizon =
		input.horizon === undefined || input.horizon === null
			? 1
			: Number(input.horizon);
	const timeframe = input.timeframe ?? "ONE_HOUR";
	if (
		!(timeframe in TIMEFRAME_MILLISECONDS) ||
		!Number.isSafeInteger(from) ||
		!Number.isSafeInteger(to) ||
		from <= 0 ||
		to <= 0 ||
		from > to
	) {
		return { ok: false, code: "INVALID_REQUEST" };
	}
	if (!Number.isSafeInteger(horizon) || horizon < 1 || horizon > 24) {
		return { ok: false, code: "INVALID_HORIZON" };
	}
	const collection: CalibrationCollection =
		input.collection === "SHADOW" || input.collection === "RETROSPECTIVE"
			? input.collection
			: "ALL";
	const timeframeMs = TIMEFRAME_MILLISECONDS[timeframe as Timeframe];
	if ((to - from) / timeframeMs > AI_TREND_CALIBRATION_MAX_CANDLES) {
		return { ok: false, code: "WINDOW_TOO_LARGE" };
	}
	return {
		ok: true,
		query: {
			from,
			to,
			collection,
			horizon,
			timeframe: timeframe as Timeframe,
			timeframeMs,
		},
	};
};
