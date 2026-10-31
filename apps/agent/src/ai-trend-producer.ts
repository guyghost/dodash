/**
 * AI trend signal producer, SHADOW mode (models/ai-trend-signal.md §3-4).
 *
 * Shell effect: builds the closed CHOICE question (UP/DOWN/NEUTRAL) on the
 * state of candles closed at or before the decision candle, drives the
 * port's `aiDecisionWorkerMachine` (sole owner of the retry budget) and
 * persists the resulting `AiTrendSignal` through an injected sink.
 *
 * SHADOW means produced and persisted, never consumed: nothing in the
 * trading decision chain reads this signal, no `tradingCycleMachine` event
 * or transition depends on it (INV 1, §6). A refusal or a failure produces
 * no signal (§3.2); an absent signal later resolves to the identity
 * decorator. The mode is deployment-frozen configuration
 * (`AI_TREND_MODE`, default SHADOW when `AI_GATEWAY_KEY` is present).
 */
import {
	type Candle,
	TIMEFRAME_MILLISECONDS,
	type Timeframe,
} from "@dodash/domain";
import { computeIndicators } from "@dodash/indicators-prolog";
import {
	type AiAnswer,
	type AiDecisionRequest,
	type AiDecisionResult,
	type AiQuestion,
	type AiTrendBias,
	type AiTrendSignal,
	aiDecisionWorkerMachine,
	buildRetrospectiveTrendState,
	composeTrendFromBatteryV2,
	resolveTrendThresholdBps,
	type TrendStateBuild,
} from "@dodash/models";
import { createActor } from "xstate";

export const AI_TREND_QUESTION_ID = "trend";

/** Question fermée de tendance (§3.1) : options figées avant l'appel. */
export const AI_TREND_QUESTION = {
	kind: "CHOICE",
	id: AI_TREND_QUESTION_ID,
	instructions:
		"Quelle est la tendance de prix à court terme du produit, au vu des bougies closes fournies ?",
	options: ["UP", "DOWN", "NEUTRAL"],
} as const;

export const AI_TREND_DECISION_TIMEOUT_MS = 5_000;

/** Fenêtre d'état du signal (amendement 2026-10-30) : 120 bougies de la grille du signal. */
export const AI_TREND_CANDLE_LIMIT = 120;

/**
 * Grille propre du signal : `AI_TREND_TIMEFRAME` figé par déploiement,
 * repli sur le timeframe du produit si absent ou inconnu.
 */
export const resolveTrendTimeframe = (
	raw: string | undefined,
	fallback: Timeframe,
): Timeframe =>
	raw !== undefined && raw in TIMEFRAME_MILLISECONDS
		? (raw as Timeframe)
		: fallback;

export const AI_TREND_SIGNALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ai_trend_signals (
    product_id TEXT NOT NULL,
    candle_closed_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    bias TEXT NOT NULL,
    probability REAL NOT NULL,
    provider TEXT NOT NULL,
    latency_ms INTEGER,
    input_tokens INTEGER,
    collection TEXT NOT NULL DEFAULT 'SHADOW',
    question_version TEXT NOT NULL DEFAULT 'v1',
    timeframe TEXT NOT NULL DEFAULT 'ONE_MINUTE',
    threshold_bps REAL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (product_id, candle_closed_at, question_version, timeframe)
  )
`;

/**
 * Live state construction (§3.1) : seule compte l'information close à ou
 * avant la bougie de référence — la bougie en formation (clôture future)
 * et toute bougie postérieure sont exclues par construction. Le rejet
 * bloquant `LOOKAHEAD` reste la garantie du builder rétrospectif (§7.A,
 * INV 10) : ici, l'exclusion est silencieuse car le snapshot brut est la
 * réalité à l'instant T, pas un jeu de données construit.
 */
export const mapCandlesToTrendState = (
	candles: readonly Candle[],
	timeframeMs: number,
	candleClosedAt: number,
): TrendStateBuild =>
	buildRetrospectiveTrendState(
		candles
			.filter((candle) => candle.start + timeframeMs <= candleClosedAt)
			.map((candle) => ({
				closeTime: candle.start + timeframeMs,
				open: candle.open,
				high: candle.high,
				low: candle.low,
				close: candle.close,
				volume: candle.volume,
			})),
		candleClosedAt,
	);

export type ResolvedTrend = {
	readonly bias: AiTrendBias;
	readonly probability: number;
};

/**
 * Resolves the trend from the port answers: the reported probability
 * distribution of the `trend` choice question, argmax with a deterministic
 * tie-break in the declared option order (UP before DOWN before NEUTRAL).
 */
export const resolveTrendFromAnswers = (
	answers: readonly AiAnswer[],
): ResolvedTrend | null => {
	for (const answer of answers) {
		if (answer.kind !== "CHOICE" || answer.id !== AI_TREND_QUESTION_ID)
			continue;
		let bias: AiTrendBias | null = null;
		let probability = -1;
		for (const option of AI_TREND_QUESTION.options) {
			const value = answer.probabilities[option];
			if (typeof value === "number" && value > probability) {
				probability = value;
				bias = option;
			}
		}
		return bias === null || probability < 0 ? null : { bias, probability };
	}
	return null;
};

/**
 * Drives `aiDecisionWorkerMachine` around an injected decision effect: the
 * machine owns validation and the bounded retry budget; `decide` is called
 * once per entry into `requesting` (first call plus retries) and its result
 * is reported back as `RESULT`. Settles on the machine's terminal state.
 */
export const runDecisionWithMachine = (
	request: AiDecisionRequest,
	decide: (
		request: AiDecisionRequest,
		attempt: number,
	) => Promise<AiDecisionResult>,
): Promise<AiDecisionResult> =>
	new Promise((resolve) => {
		const actor = createActor(aiDecisionWorkerMachine);
		let inFlight = false;
		let settled = false;
		const finish = (result: AiDecisionResult) => {
			if (settled) return;
			settled = true;
			actor.stop();
			resolve(result);
		};
		actor.subscribe((snapshot) => {
			if (snapshot.value === "requesting") {
				if (inFlight) return;
				inFlight = true;
				void decide(request, snapshot.context.attempts)
					.then((result) => {
						inFlight = false;
						actor.send({ type: "RESULT", result });
					})
					.catch(() => {
						inFlight = false;
						actor.send({
							type: "RESULT",
							result: { kind: "FAILED", errorCode: "AI_PROVIDER_ERROR" },
						});
					});
				return;
			}
			if (snapshot.value === "failed") {
				finish({
					kind: "FAILED",
					errorCode: snapshot.context.errorCode ?? "AI_PROVIDER_ERROR",
				});
				return;
			}
			if (snapshot.status === "done" && snapshot.context.lastResult !== null) {
				finish(snapshot.context.lastResult);
			}
		});
		actor.start();
		actor.send({ type: "REQUEST", request });
	});

export interface TrendSignalMeta {
	readonly latencyMs: number;
	readonly inputTokens?: number;
}

export interface TrendCollectDeps {
	readonly productId: string;
	readonly timeframe: string;
	readonly timeframeMs: number;
	readonly triggeredAt: number;
	readonly candles: readonly Candle[];
	readonly nowMs: () => number;
	readonly decide: (
		request: AiDecisionRequest,
		attempt: number,
	) => Promise<AiDecisionResult>;
	readonly persist: TrendPersistFn;
	readonly log: (entry: Record<string, unknown>) => void;
}

export type TrendCollectOutcome =
	| { readonly kind: "PERSISTED" }
	| {
			readonly kind: "SKIPPED";
			readonly reason: "LOOKAHEAD" | "EMPTY" | "UNRESOLVED";
	  }
	| { readonly kind: "NOT_PRODUCED"; readonly result: AiDecisionResult };

/**
 * SHADOW collection of one trend signal: same decision-candle identity as
 * the cycle (`floor(triggeredAt / timeframe) × timeframe`), state closed at
 * or before that candle, question issued through the machine-driven port,
 * signal persisted at production time (§3.2) — never consumed.
 */
export const collectTrendSignal = async (
	deps: TrendCollectDeps,
): Promise<TrendCollectOutcome> => {
	const candleClosedAt =
		Math.floor(deps.triggeredAt / deps.timeframeMs) * deps.timeframeMs;
	const built = mapCandlesToTrendState(
		deps.candles,
		deps.timeframeMs,
		candleClosedAt,
	);
	if (!built.ok) {
		deps.log({
			event: "ai_trend_skipped",
			productId: deps.productId,
			candleClosedAt,
			reason: built.errorCode,
		});
		return { kind: "SKIPPED", reason: built.errorCode };
	}
	const request: AiDecisionRequest = {
		provider: "jev",
		state: built.state,
		questions: [AI_TREND_QUESTION],
		timeoutMs: AI_TREND_DECISION_TIMEOUT_MS,
	};
	const result = await runDecisionWithMachine(request, deps.decide);
	if (result.kind !== "ANSWERED") {
		deps.log({
			event: "ai_trend_unavailable",
			productId: deps.productId,
			candleClosedAt,
			resultKind: result.kind,
			errorCode: result.kind === "FAILED" ? result.errorCode : null,
		});
		return { kind: "NOT_PRODUCED", result };
	}
	const trend = resolveTrendFromAnswers(result.answers);
	if (trend === null) {
		deps.log({
			event: "ai_trend_skipped",
			productId: deps.productId,
			candleClosedAt,
			reason: "UNRESOLVED",
		});
		return { kind: "SKIPPED", reason: "UNRESOLVED" };
	}
	const signal: AiTrendSignal = {
		kind: "AI_TREND",
		productId: deps.productId,
		candleClosedAt,
		observedAt: deps.nowMs(),
		bias: trend.bias,
		probability: trend.probability,
		provider: "jev",
	};
	const meta: TrendSignalMeta =
		result.inputTokens === undefined
			? { latencyMs: result.latencyMs }
			: { latencyMs: result.latencyMs, inputTokens: result.inputTokens };
	deps.persist(signal, meta, "SHADOW", "v1", null, deps.timeframe);
	deps.log({
		event: "ai_trend_signal_persisted",
		productId: deps.productId,
		candleClosedAt,
		observedAt: signal.observedAt,
		bias: signal.bias,
		probability: signal.probability,
		latencyMs: result.latencyMs,
	});
	return { kind: "PERSISTED" };
};

/** Provenance (§9) : partagé avec le collecteur rétrospectif. */
export type AiTrendCollection = "SHADOW" | "RETROSPECTIVE";

/** Version de la question (§9) : v1 = CHOICE unique, v2 = batterie d'événements. */
export type AiTrendQuestionVersion = "v1" | "v2";

/** Persistance unifiée du signal (INV 16 : θ persisté à la production). */
export type TrendPersistFn = (
	signal: AiTrendSignal,
	meta: TrendSignalMeta,
	collection: AiTrendCollection,
	questionVersion: AiTrendQuestionVersion,
	thresholdBps: number | null,
	timeframe: string,
) => void;

/** §9 : horizon de la batterie v2, en bougies de la grille du signal. */
export const AI_TREND_V2_HORIZON = 15;

/** Fenêtre minimale de features (60 min + marge indicateurs). */
export const AI_TREND_V2_MIN_CANDLES = 70;

export interface TrendFeaturesV2 {
	readonly symbol: string;
	readonly close: number;
	readonly r1: number;
	readonly r5: number;
	readonly r15: number;
	readonly r60: number;
	readonly vol15Bps: number;
	readonly vol60Bps: number;
	readonly rsi14: number;
	readonly emaFastDistBps: number;
	readonly emaSlowDistBps: number;
	readonly distHigh60Bps: number;
	readonly distLow60Bps: number;
	readonly volRatio: number;
	readonly session: string;
	readonly horizonMinutes: number;
	readonly thresholdBps: number;
}

const sessionOf = (utcHour: number): string =>
	utcHour >= 8 && utcHour < 14
		? "EU"
		: utcHour >= 14 && utcHour < 22
			? "US"
			: "ASIA";

const realizedVolBps = (closes: readonly number[]): number => {
	if (closes.length < 2) return 0;
	const returns: number[] = [];
	for (let i = 1; i < closes.length; i++) {
		const prev = closes[i - 1];
		if (prev === undefined || prev <= 0) return 0;
		returns.push(Math.log(closes[i]! / prev) * 10_000);
	}
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const variance =
		returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
	return Math.sqrt(variance);
};

/**
 * Features v2 (§9, INV 15) : uniquement des bougies closes — l'appelant a
 * déjà filtré la bougie en formation. Rendements en %, distances en bps ;
 * θ vol-scalé via la fonction pure de models/.
 */
export const computeTrendFeaturesV2 = async (
	productId: string,
	candles: readonly Candle[],
	horizonMinutes: number = AI_TREND_V2_HORIZON,
): Promise<TrendFeaturesV2 | null> => {
	if (candles.length < AI_TREND_V2_MIN_CANDLES) return null;
	const last = candles[candles.length - 1];
	const closes = candles.map((candle) => candle.close);
	const close = last?.close;
	if (last === undefined || close === undefined || close <= 0) return null;
	const snapshot = await computeIndicators(candles);
	if (!snapshot.ok) return null;
	const pct = (n: number) => {
		const base = closes[closes.length - 1 - n];
		return base !== undefined && base > 0 ? ((close - base) / base) * 100 : 0;
	};
	const window = <T>(pick: (c: Candle) => T, n: number): T[] =>
		candles.slice(-n).map(pick);
	const highs = window((c) => c.high, 60);
	const lows = window((c) => c.low, 60);
	const vols = window((c) => c.volume, 60);
	const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const vol5 = avg(vols.slice(-5));
	const vol60 = avg(vols);
	const vol15Bps = realizedVolBps(closes.slice(-16));
	return {
		symbol: productId,
		close,
		r1: pct(1),
		r5: pct(5),
		r15: pct(15),
		r60: pct(60),
		vol15Bps,
		vol60Bps: realizedVolBps(closes.slice(-61)),
		rsi14: snapshot.value.rsi,
		emaFastDistBps:
			((close - snapshot.value.emaFast) / snapshot.value.emaFast) * 10_000,
		emaSlowDistBps:
			((close - snapshot.value.emaSlow) / snapshot.value.emaSlow) * 10_000,
		distHigh60Bps: ((close - Math.max(...highs)) / close) * 10_000,
		distLow60Bps: ((close - Math.min(...lows)) / close) * 10_000,
		volRatio: vol60 > 0 ? vol5 / vol60 : 1,
		session: sessionOf(new Date(last.start).getUTCHours()),
		horizonMinutes,
		thresholdBps: resolveTrendThresholdBps(vol15Bps),
	};
};

/** Batterie v2 (§9) : événements ±θ à l'horizon, régime et lisibilité. */
export const buildTrendQuestionsV2 = (
	thresholdBps: number,
	horizonMinutes: number = AI_TREND_V2_HORIZON,
): readonly AiQuestion[] =>
	Object.freeze([
		{
			kind: "PREDICATE",
			id: "up15",
			instructions: `La clôture dans ${horizonMinutes} minutes sera-t-elle supérieure ou égale à ${(1 + thresholdBps / 10_000).toFixed(5)} fois la dernière clôture fournie (hausse d'au moins ${thresholdBps.toFixed(1)} bps) ?`,
		},
		{
			kind: "PREDICATE",
			id: "down15",
			instructions: `La clôture dans ${horizonMinutes} minutes sera-t-elle inférieure ou égale à ${(1 - thresholdBps / 10_000).toFixed(5)} fois la dernière clôture fournie (baisse d'au moins ${thresholdBps.toFixed(1)} bps) ?`,
		},
		{
			kind: "CHOICE",
			id: "regime",
			instructions:
				"Quel est le régime dominant de l'état fourni ? (télémétrie seule)",
			options: ["TREND_UP", "TREND_DOWN", "RANGE", "VOLATILE"],
		},
		{
			kind: "SCORE",
			id: "readability",
			instructions:
				"Quelle est la lisibilité de cet état pour juger la direction à court terme ? (télémétrie seule)",
			levels: ["ILLISIBLE", "POUVRE", "LISIBLE", "NETTE", "EVIDENTE"],
		},
	]);

export interface TrendBatteryProbabilities {
	readonly up: number;
	readonly down: number;
}

/** Extrait pUp/pDown des réponses PREDICATE de la batterie. */
export const extractBatteryProbabilities = (
	answers: readonly AiAnswer[],
): TrendBatteryProbabilities | null => {
	let up: number | null = null;
	let down: number | null = null;
	for (const answer of answers) {
		if (answer.kind !== "PREDICATE") continue;
		if (answer.id === "up15") up = answer.probability;
		if (answer.id === "down15") down = answer.probability;
	}
	return up === null || down === null ? null : { up, down };
};

export interface TrendCollectV2Deps {
	readonly productId: string;
	readonly timeframe: string;
	readonly timeframeMs: number;
	readonly triggeredAt: number;
	readonly candles: readonly Candle[];
	readonly nowMs: () => number;
	readonly decide: (
		request: AiDecisionRequest,
		attempt: number,
	) => Promise<AiDecisionResult>;
	readonly persist: TrendPersistFn;
	readonly log: (entry: Record<string, unknown>) => void;
}

export type TrendCollectV2Outcome =
	| { readonly kind: "PERSISTED" }
	| { readonly kind: "SKIPPED"; readonly reason: "EMPTY" | "UNRESOLVED" }
	| { readonly kind: "NOT_PRODUCED"; readonly result: AiDecisionResult };

/** Collecte SHADOW v2 (§9) : features → batterie → composition pure → persistance v2. */
export const collectTrendSignalV2 = async (
	deps: TrendCollectV2Deps,
): Promise<TrendCollectV2Outcome> => {
	const candleClosedAt =
		Math.floor(deps.triggeredAt / deps.timeframeMs) * deps.timeframeMs;
	const closed = deps.candles.filter(
		(candle) => candle.start + deps.timeframeMs <= candleClosedAt,
	);
	const features = await computeTrendFeaturesV2(deps.productId, closed);
	if (features === null) {
		deps.log({
			event: "ai_trend_skipped",
			productId: deps.productId,
			candleClosedAt,
			reason: "EMPTY",
			version: "v2",
		});
		return { kind: "SKIPPED", reason: "EMPTY" };
	}
	const request: AiDecisionRequest = {
		provider: "jev",
		state: { json: features },
		questions: buildTrendQuestionsV2(features.thresholdBps),
		timeoutMs: AI_TREND_DECISION_TIMEOUT_MS,
	};
	const result = await runDecisionWithMachine(request, deps.decide);
	if (result.kind !== "ANSWERED") {
		deps.log({
			event: "ai_trend_unavailable",
			productId: deps.productId,
			candleClosedAt,
			resultKind: result.kind,
			version: "v2",
		});
		return { kind: "NOT_PRODUCED", result };
	}
	const battery = extractBatteryProbabilities(result.answers);
	const trend =
		battery === null
			? null
			: composeTrendFromBatteryV2(battery.up, battery.down);
	if (trend === null) {
		deps.log({
			event: "ai_trend_skipped",
			productId: deps.productId,
			candleClosedAt,
			reason: "UNRESOLVED",
			version: "v2",
		});
		return { kind: "SKIPPED", reason: "UNRESOLVED" };
	}
	const signal: AiTrendSignal = {
		kind: "AI_TREND",
		productId: deps.productId,
		candleClosedAt,
		observedAt: deps.nowMs(),
		bias: trend.bias,
		probability: trend.probability,
		provider: "jev",
	};
	const meta: TrendSignalMeta =
		result.inputTokens === undefined
			? { latencyMs: result.latencyMs }
			: { latencyMs: result.latencyMs, inputTokens: result.inputTokens };
	deps.persist(
		signal,
		meta,
		"SHADOW",
		"v2",
		features.thresholdBps,
		deps.timeframe,
	);
	deps.log({
		event: "ai_trend_signal_persisted",
		productId: deps.productId,
		candleClosedAt,
		observedAt: signal.observedAt,
		bias: signal.bias,
		probability: signal.probability,
		latencyMs: result.latencyMs,
		version: "v2",
		thresholdBps: features.thresholdBps,
	});
	return { kind: "PERSISTED" };
};
