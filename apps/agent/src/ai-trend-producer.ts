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
import {
	type AiAnswer,
	type AiDecisionRequest,
	type AiDecisionResult,
	type AiTrendBias,
	type AiTrendSignal,
	aiDecisionWorkerMachine,
	buildRetrospectiveTrendState,
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
    created_at INTEGER NOT NULL,
    PRIMARY KEY (product_id, candle_closed_at)
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
	readonly timeframeMs: number;
	readonly triggeredAt: number;
	readonly candles: readonly Candle[];
	readonly nowMs: () => number;
	readonly decide: (
		request: AiDecisionRequest,
		attempt: number,
	) => Promise<AiDecisionResult>;
	readonly persist: (signal: AiTrendSignal, meta: TrendSignalMeta) => void;
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
	deps.persist(signal, meta);
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
