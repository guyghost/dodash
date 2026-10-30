/**
 * Retrospective trend-signal collector — protocol A
 * (models/ai-trend-signal.md §7.A).
 *
 * For each past reference candle C of the grid, fetches the historical
 * candle window (only data closed at or before C), issues the closed CHOICE
 * question through the machine-driven port and persists the signal with
 * `candleClosedAt = C` and `observedAt` = real call time. State construction
 * is strict: any candle closing after C is a blocking LOOKAHEAD defect that
 * aborts the batch (INV 10) — unlike the live SHADOW producer, where the
 * forming candle is normal reality.
 *
 * Provenance: rows are tagged `RETROSPECTIVE` and never overwrite a SHADOW
 * row (the prospective sample is the clean out-of-sample, INV 12); every
 * report derived from this collector must carry
 * `RETROSPECTIVE_POSSIBLY_CONTAMINATED`.
 */

import {
	type Candle,
	createCandle,
	err,
	ok,
	type Result,
} from "@dodash/domain";
import {
	type AiDecisionRequest,
	type AiDecisionResult,
	type AiTrendSignal,
	buildRetrospectiveTrendState,
	type TrendStateBuild,
} from "@dodash/models";
import { z } from "zod";
import type { AiTrendCollection } from "./ai-trend-producer.js";
import {
	AI_TREND_DECISION_TIMEOUT_MS,
	AI_TREND_QUESTION,
	resolveTrendFromAnswers,
	runDecisionWithMachine,
	type TrendSignalMeta,
} from "./ai-trend-producer.js";

/** Bounded batch per invocation: one grid candle = one Jev call. */
export const AI_TREND_RETROSPECTIVE_MAX_CANDLES = 48;

export type RetrospectivePlan =
	| { readonly ok: true; readonly candles: readonly number[] }
	| {
			readonly ok: false;
			readonly errorCode:
				| "INVALID_WINDOW"
				| "MISALIGNED_WINDOW"
				| "WINDOW_TOO_LARGE";
	  };

/**
 * Grid planning: ascending reference candles `C` (multiples of the
 * timeframe) within `[from, to]`, at most
 * `AI_TREND_RETROSPECTIVE_MAX_CANDLES` per batch.
 */
export const planRetrospectiveCandles = (
	fromCandleClosedAt: number,
	toCandleClosedAt: number,
	timeframeMs: number,
): RetrospectivePlan => {
	if (
		!Number.isSafeInteger(fromCandleClosedAt) ||
		!Number.isSafeInteger(toCandleClosedAt) ||
		!Number.isSafeInteger(timeframeMs) ||
		timeframeMs <= 0 ||
		fromCandleClosedAt > toCandleClosedAt
	) {
		return { ok: false, errorCode: "INVALID_WINDOW" };
	}
	if (
		fromCandleClosedAt % timeframeMs !== 0 ||
		toCandleClosedAt % timeframeMs !== 0
	) {
		return { ok: false, errorCode: "MISALIGNED_WINDOW" };
	}
	const count = (toCandleClosedAt - fromCandleClosedAt) / timeframeMs + 1;
	if (count > AI_TREND_RETROSPECTIVE_MAX_CANDLES) {
		return { ok: false, errorCode: "WINDOW_TOO_LARGE" };
	}
	const candles: number[] = [];
	for (let c = fromCandleClosedAt; c <= toCandleClosedAt; c += timeframeMs) {
		candles.push(c);
	}
	return { ok: true, candles: Object.freeze(candles) };
};

const historicalResponseSchema = z.object({
	productId: z.string(),
	timeframe: z.string(),
	candles: z.array(
		z.object({
			start: z.number().int().nonnegative(),
			open: z.number(),
			high: z.number(),
			low: z.number(),
			close: z.number(),
			volume: z.number(),
		}),
	),
});

export interface RetrospectiveCandleRequest {
	readonly productId: string;
	readonly timeframe: string;
	readonly limit: number;
	/** Reference candle C, milliseconds; the service receives the start of the newest closed candle, in seconds. */
	readonly candleClosedAt: number;
	readonly timeframeMs: number;
}

export type HistoricalCandleFetch =
	| { readonly ok: true; readonly candles: readonly Candle[] }
	| {
			readonly ok: false;
			readonly code: "MARKET_FETCH_FAILED" | "INVALID_RESPONSE";
	  };

/**
 * Historical window through the market-data service: the newest candle
 * included closes exactly at C (`end` = start of that candle, seconds) —
 * same seam as the live fetch, no ticker, no live freshness gate.
 */
export const fetchCandlesViaMarketService = async (
	service: { fetch: typeof fetch },
	internalToken: string,
	request: RetrospectiveCandleRequest,
): Promise<HistoricalCandleFetch> => {
	let response: Response;
	try {
		response = await service.fetch("https://market-data/internal/candles", {
			method: "POST",
			headers: {
				authorization: `Bearer ${internalToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				productId: request.productId,
				timeframe: request.timeframe,
				limit: request.limit,
				end: Math.floor((request.candleClosedAt - request.timeframeMs) / 1_000),
			}),
		});
	} catch {
		return { ok: false, code: "MARKET_FETCH_FAILED" };
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return { ok: false, code: "MARKET_FETCH_FAILED" };
	}
	let parsed: z.infer<typeof historicalResponseSchema>;
	try {
		parsed = historicalResponseSchema.parse(await response.json());
	} catch {
		return { ok: false, code: "INVALID_RESPONSE" };
	}
	const candles: Candle[] = [];
	for (const raw of parsed.candles) {
		const candle = createCandle(raw);
		if (!candle.ok) return { ok: false, code: "INVALID_RESPONSE" };
		candles.push(candle.value);
	}
	return { ok: true, candles };
};

export interface RetrospectiveCollectDeps {
	readonly productId: string;
	readonly timeframe: string;
	readonly timeframeMs: number;
	readonly candleLimit: number;
	readonly fromCandleClosedAt: number;
	readonly toCandleClosedAt: number;
	/** Re-collect RETROSPECTIVE rows; SHADOW rows are never overwritten nor re-queried. */
	readonly force: boolean;
	readonly fetchCandles: (
		request: RetrospectiveCandleRequest,
	) => Promise<HistoricalCandleFetch>;
	readonly decide: (
		request: AiDecisionRequest,
		attempt: number,
	) => Promise<AiDecisionResult>;
	readonly loadExisting: () => Promise<ReadonlyMap<number, AiTrendCollection>>;
	readonly persist: (
		signal: AiTrendSignal,
		meta: TrendSignalMeta,
		collection: AiTrendCollection,
	) => void;
	readonly nowMs: () => number;
	readonly log: (entry: Record<string, unknown>) => void;
}

export type RetrospectivePlanError = Extract<
	RetrospectivePlan,
	{ ok: false }
>["errorCode"];

export interface RetrospectiveCollectReport {
	readonly collected: number;
	readonly skippedExisting: number;
	readonly unavailable: number;
	readonly empty: number;
	readonly aborted: null | "LOOKAHEAD";
	readonly planError: RetrospectivePlanError | null;
}

export const collectRetrospectiveTrendSignals = async (
	deps: RetrospectiveCollectDeps,
): Promise<RetrospectiveCollectReport> => {
	const plan = planRetrospectiveCandles(
		deps.fromCandleClosedAt,
		deps.toCandleClosedAt,
		deps.timeframeMs,
	);
	const report: RetrospectiveCollectReport = {
		collected: 0,
		skippedExisting: 0,
		unavailable: 0,
		empty: 0,
		aborted: null,
		planError: null,
	};
	const counters = { ...report };
	if (!plan.ok) {
		deps.log({
			event: "ai_trend_retrospective_rejected",
			errorCode: plan.errorCode,
		});
		return { ...report, planError: plan.errorCode };
	}
	const existing = await deps.loadExisting();
	for (const candleClosedAt of plan.candles) {
		const priorCollection = existing.get(candleClosedAt);
		// Une ligne SHADOW est l'échantillon prospectif propre : jamais réécrite,
		// jamais réinterrogée (INV 12). Une ligne RETROSPECTIVE n'est re-collectée
		// que sur force.
		if (
			priorCollection === "SHADOW" ||
			(priorCollection === "RETROSPECTIVE" && !deps.force)
		) {
			counters.skippedExisting += 1;
			continue;
		}
		const fetched = await deps.fetchCandles({
			productId: deps.productId,
			timeframe: deps.timeframe,
			limit: deps.candleLimit,
			candleClosedAt,
			timeframeMs: deps.timeframeMs,
		});
		if (!fetched.ok) {
			counters.unavailable += 1;
			deps.log({
				event: "ai_trend_retrospective_unavailable",
				candleClosedAt,
				code: fetched.code,
			});
			continue;
		}
		const built: TrendStateBuild = buildRetrospectiveTrendState(
			fetched.candles.map((candle) => ({
				closeTime: candle.start + deps.timeframeMs,
				open: candle.open,
				high: candle.high,
				low: candle.low,
				close: candle.close,
				volume: candle.volume,
			})),
			candleClosedAt,
		);
		if (!built.ok) {
			if (built.errorCode === "LOOKAHEAD") {
				// INV 10 : défaut bloquant du producteur — le lot s'arrête net.
				counters.aborted = "LOOKAHEAD";
				deps.log({
					event: "ai_trend_retrospective_defect",
					candleClosedAt,
					reason: "LOOKAHEAD",
				});
				break;
			}
			counters.empty += 1;
			continue;
		}
		const request: AiDecisionRequest = {
			provider: "jev",
			state: built.state,
			questions: [AI_TREND_QUESTION],
			timeoutMs: AI_TREND_DECISION_TIMEOUT_MS,
		};
		const result = await runDecisionWithMachine(request, deps.decide);
		if (result.kind !== "ANSWERED") {
			counters.unavailable += 1;
			deps.log({
				event: "ai_trend_retrospective_unavailable",
				candleClosedAt,
				resultKind: result.kind,
				errorCode: result.kind === "FAILED" ? result.errorCode : null,
			});
			continue;
		}
		const trend = resolveTrendFromAnswers(result.answers);
		if (trend === null) {
			counters.unavailable += 1;
			continue;
		}
		deps.persist(
			{
				kind: "AI_TREND",
				productId: deps.productId,
				candleClosedAt,
				observedAt: deps.nowMs(),
				bias: trend.bias,
				probability: trend.probability,
				provider: "jev",
			},
			result.inputTokens === undefined
				? { latencyMs: result.latencyMs }
				: { latencyMs: result.latencyMs, inputTokens: result.inputTokens },
			"RETROSPECTIVE",
		);
		counters.collected += 1;
	}
	const finalReport: RetrospectiveCollectReport = {
		...counters,
		planError: null,
	};
	deps.log({
		event: "ai_trend_retrospective_batch",
		productId: deps.productId,
		collected: finalReport.collected,
		skippedExisting: finalReport.skippedExisting,
		unavailable: finalReport.unavailable,
		empty: finalReport.empty,
		aborted: finalReport.aborted,
		label: "RETROSPECTIVE_POSSIBLY_CONTAMINATED",
	});
	return finalReport;
};

export type RetrospectiveCommandResult = Result<
	RetrospectiveCommand,
	{ code: string }
>;

export const retrospectiveCommandSchema = z.object({
	productId: z.string().min(1),
	timeframe: z.enum([
		"ONE_MINUTE",
		"FIVE_MINUTE",
		"FIFTEEN_MINUTE",
		"ONE_HOUR",
		"SIX_HOUR",
		"ONE_DAY",
	]),
	fromCandleClosedAt: z.number().int().nonnegative(),
	toCandleClosedAt: z.number().int().nonnegative(),
	candleLimit: z.number().int().min(10).max(300).default(100),
	force: z.boolean().default(false),
});

export type RetrospectiveCommand = z.infer<typeof retrospectiveCommandSchema>;

export const parseRetrospectiveCommand = (
	input: unknown,
): RetrospectiveCommandResult => {
	const parsed = retrospectiveCommandSchema.safeParse(input);
	return parsed.success ? ok(parsed.data) : err({ code: "INVALID_REQUEST" });
};
