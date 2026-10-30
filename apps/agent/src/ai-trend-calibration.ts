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
import type { AiTrendBias, TrendOutcome } from "@dodash/models";
import type { AiTrendCollection } from "./ai-trend-retrospective.js";

export interface TrendSignalRow {
	readonly productId: string;
	readonly candleClosedAt: number;
	readonly observedAt: number;
	readonly bias: AiTrendBias;
	readonly probability: number;
	readonly collection: AiTrendCollection;
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
		if (outcomeClose > referenceClose) return { ...row, outcome: "UP" };
		if (outcomeClose < referenceClose) return { ...row, outcome: "DOWN" };
		return { ...row, outcome: "FLAT" };
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
