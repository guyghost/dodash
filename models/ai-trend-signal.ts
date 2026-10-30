/**
 * AI trend signal modulation (models/ai-trend-signal.md).
 *
 * Pure and network-free: the provider runs in the shell's AI worker and
 * only the recorded `AiTrendSignal` type reaches the pure core. The signal
 * never originates or flips a strategy signal (INV 1): it modulates the
 * confidence of aligned signals within `[1, maxFactor]`, strictly positive
 * by construction. The backtest replays recorded signals through these
 * exact functions (INV 8 of models/README.md, unchanged).
 */
import type { AiProvider, AiState } from "./ai-decision-worker.js";

export type AiTrendBias = "UP" | "DOWN" | "NEUTRAL";

export interface AiTrendSignal {
	readonly kind: "AI_TREND";
	readonly productId: string;
	/** Reference candle of the question (§2). */
	readonly candleClosedAt: number;
	/** Production timestamp; consumption is bounded by the freshness window (INV 11). */
	readonly observedAt: number;
	readonly bias: AiTrendBias;
	/** Calibrated probability of the bias, [0, 1]. */
	readonly probability: number;
	readonly provider: AiProvider;
}

export interface TrendPolicy {
	readonly enabled: boolean;
	readonly maxAgeMs: number;
	/** Activation threshold, > 0.5 (§2). */
	readonly minProbability: number;
	/** Modulation amplitude cap, ∈ ]1, 2] (INV 7). */
	readonly maxFactor: number;
}

export type TrendInactivityReason =
	| "DISABLED"
	| "STALE"
	| "NEUTRAL"
	| "BELOW_THRESHOLD";

export type TrendModulation =
	| { readonly kind: "INACTIVE"; readonly reason: TrendInactivityReason }
	| {
			readonly kind: "MODULATION";
			readonly bias: "UP" | "DOWN";
			readonly factor: number;
	  };

export type TrendPolicyValidation =
	| { readonly ok: true }
	| { readonly ok: false };

/** INV 7: `maxFactor ∈ ]1, 2]`, `minProbability ∈ ]0.5, 1[`, positive safe-integer `maxAgeMs`. */
export const validateTrendPolicy = (
	policy: TrendPolicy,
): TrendPolicyValidation => {
	if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0) {
		return { ok: false };
	}
	if (!(policy.minProbability > 0.5 && policy.minProbability < 1)) {
		return { ok: false };
	}
	if (!(policy.maxFactor > 1 && policy.maxFactor <= 2)) {
		return { ok: false };
	}
	return { ok: true };
};

/**
 * Resolves the modulation of one recorded signal at instant `now`
 * (§2). Freshness window per §7/INV 11, strict upper bound:
 * `observedAt ≤ now < observedAt + maxAgeMs`. The factor is linear in
 * probability and clamped into `[1, maxFactor]` unconditionally, so even a
 * malformed probability cannot break INV 1.
 */
export const evaluateTrendSignal = (
	signal: AiTrendSignal,
	policy: TrendPolicy,
	now: number,
): TrendModulation => {
	if (!policy.enabled) {
		return Object.freeze({ kind: "INACTIVE", reason: "DISABLED" });
	}
	if (
		!(now >= signal.observedAt && now < signal.observedAt + policy.maxAgeMs)
	) {
		return Object.freeze({ kind: "INACTIVE", reason: "STALE" });
	}
	if (signal.bias === "NEUTRAL") {
		return Object.freeze({ kind: "INACTIVE", reason: "NEUTRAL" });
	}
	if (signal.probability < policy.minProbability) {
		return Object.freeze({ kind: "INACTIVE", reason: "BELOW_THRESHOLD" });
	}
	const span = 1 - policy.minProbability;
	const raw =
		1 +
		((signal.probability - policy.minProbability) / span) *
			(policy.maxFactor - 1);
	const factor = Math.min(policy.maxFactor, Math.max(1, raw));
	return Object.freeze({ kind: "MODULATION", bias: signal.bias, factor });
};

/**
 * Structural strategy-signal view: models/ does not depend on
 * `@dodash/domain`, whose `Signal` is structurally assignable to it.
 */
export interface ModulableSignal {
	readonly productId: string;
	readonly side: "BUY" | "SELL" | "HOLD";
	readonly confidence: number;
}

/**
 * Deterministic decorator of the strategy boundary (§2): multiplies the
 * confidence of signals aligned with the bias, leaves everything else
 * unchanged (INV 1: `factor > 0`, no direction flip, no origination);
 * confidence stays capped at 1 (§6).
 */
export const applyTrendModulation = <T extends ModulableSignal>(
	signal: T,
	modulation: TrendModulation,
): T => {
	if (modulation.kind === "INACTIVE") {
		return signal;
	}
	const aligned = signal.side === (modulation.bias === "UP" ? "BUY" : "SELL");
	if (!aligned) {
		return signal;
	}
	return {
		...signal,
		confidence: Math.min(1, signal.confidence * modulation.factor),
	};
};

/**
 * INV 8: at most one consumed signal per `(productId, candleClosedAt)`;
 * the most recent `observedAt` wins, ties resolved by array order.
 */
export const dedupeTrendSignals = (
	signals: readonly AiTrendSignal[],
): readonly AiTrendSignal[] => {
	const winners = new Map<string, { signal: AiTrendSignal; index: number }>();
	for (const [index, signal] of signals.entries()) {
		const key = `${signal.productId}\u0000${signal.candleClosedAt}`;
		const current = winners.get(key);
		if (current === undefined) {
			winners.set(key, { signal, index });
		} else if (signal.observedAt >= current.signal.observedAt) {
			// Replacing keeps the first-appearance slot so output order stays stable.
			winners.set(key, { signal, index: current.index });
		}
	}
	return Object.freeze(
		[...winners.values()]
			.sort((a, b) => a.index - b.index)
			.map((w) => w.signal),
	);
};

export interface TrendCandleInput {
	readonly closeTime: number;
	readonly open: number;
	readonly high: number;
	readonly low: number;
	readonly close: number;
	readonly volume: number;
}

export type TrendStateBuild =
	| { readonly ok: true; readonly state: AiState }
	| { readonly ok: false; readonly errorCode: "LOOKAHEAD" | "EMPTY" };

/** Issue réalisée d'une bougie de référence (§8) ; FLAT = strictement égale. */
export type TrendOutcome = "UP" | "DOWN" | "FLAT" | "PENDING";

export interface TrendCalibrationSample {
	readonly productId: string;
	readonly candleClosedAt: number;
	readonly bias: AiTrendBias;
	readonly probability: number;
	readonly outcome: TrendOutcome;
}

export interface TrendCalibrationBin {
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
	/** Moyenne des probability du bin ; null si bin vide. */
	readonly meanProbability: number | null;
	/** Part de réponses correctes ; null si bin vide. */
	readonly accuracy: number | null;
}

export type TrendCalibrationReport =
	| {
			readonly ok: true;
			readonly sampleSize: number;
			readonly ece: number;
			readonly bins: readonly TrendCalibrationBin[];
	  }
	| { readonly ok: false; readonly errorCode: "EMPTY_SAMPLE" };

const isCorrectTrendAnswer = (
	bias: AiTrendBias,
	outcome: TrendOutcome,
): boolean => {
	if (outcome === "PENDING") return false;
	if (outcome === "FLAT") return bias === "NEUTRAL";
	return bias === outcome;
};

/**
 * ECE et courbe de fiabilité (§8) : 10 bins égaux sur [0, 1] de
 * `probability`, ECE = Σ (n_b/N)·|précision_b − confiance_b|. Pure — les
 * issues PENDING n'entrent jamais dans le calcul (INV 13) ; un échantillon
 * sans issue close est refusé explicitement.
 */
export const computeTrendCalibration = (
	samples: readonly TrendCalibrationSample[],
): TrendCalibrationReport => {
	const closed = samples.filter((sample) => sample.outcome !== "PENDING");
	if (closed.length === 0) {
		return { ok: false, errorCode: "EMPTY_SAMPLE" };
	}
	const bins: TrendCalibrationBin[] = [];
	let ece = 0;
	for (let i = 0; i < 10; i++) {
		const lower = i / 10;
		const upper = (i + 1) / 10;
		const inBin = closed.filter((sample) =>
			i === 9
				? sample.probability >= lower && sample.probability <= upper
				: sample.probability >= lower && sample.probability < upper,
		);
		if (inBin.length === 0) {
			bins.push({
				lower,
				upper,
				count: 0,
				meanProbability: null,
				accuracy: null,
			});
			continue;
		}
		const meanProbability =
			inBin.reduce((sum, sample) => sum + sample.probability, 0) / inBin.length;
		const accuracy =
			inBin.filter((sample) =>
				isCorrectTrendAnswer(sample.bias, sample.outcome),
			).length / inBin.length;
		ece +=
			(inBin.length / closed.length) * Math.abs(accuracy - meanProbability);
		bins.push({ lower, upper, count: inBin.length, meanProbability, accuracy });
	}
	return {
		ok: true,
		sampleSize: closed.length,
		ece,
		bins: Object.freeze(bins),
	};
};

/**
 * §7.A anti-lookahead state construction: any candle closing after the
 * reference candle is a blocking `LOOKAHEAD` defect (never silently
 * filtered, INV 10); the built state carries only candles closed at or
 * before `C`, sorted by close time.
 */
export const buildRetrospectiveTrendState = (
	candles: readonly TrendCandleInput[],
	candleClosedAt: number,
): TrendStateBuild => {
	if (candles.some((candle) => candle.closeTime > candleClosedAt)) {
		return { ok: false, errorCode: "LOOKAHEAD" };
	}
	const kept = [...candles]
		.filter((candle) => candle.closeTime <= candleClosedAt)
		.sort((a, b) => a.closeTime - b.closeTime);
	if (kept.length === 0) {
		return { ok: false, errorCode: "EMPTY" };
	}
	return { ok: true, state: { json: { candles: kept } } };
};

/** §9 : coefficient du seuil vol-scalé (θ = k × vol15). */
export const AI_TREND_THRESHOLD_K = 0.5;

/** θ en bps à partir de la vol réalisée 15 min (bps) ; ≥ 1 bps. */
export const resolveTrendThresholdBps = (volatility15Bps: number): number =>
	Number.isFinite(volatility15Bps) && volatility15Bps > 0
		? Math.max(1, AI_TREND_THRESHOLD_K * volatility15Bps)
		: 1;

export interface TrendBatteryOutcome {
	readonly bias: AiTrendBias;
	readonly probability: number;
}

/**
 * Composition v2 (§9, INV 17) : trois événements mutuellement exclusifs —
 * monter de θ, descendre de θ, ni l'un ni l'autre. pNeutral =
 * clamp(1 − pUp − pDown) ; argmax avec tie-break UP > DOWN > NEUTRAL ;
 * `probability` = la valeur maximale. Null si entrées hors [0, 1].
 */
export const composeTrendFromBatteryV2 = (
	probabilityUp: number,
	probabilityDown: number,
): TrendBatteryOutcome | null => {
	if (!isUnit(probabilityUp) || !isUnit(probabilityDown)) return null;
	const pNeutral = Math.min(
		1,
		Math.max(0, 1 - probabilityUp - probabilityDown),
	);
	// Ordre documenté UP > DOWN > NEUTRAL (§9) : UP gagne les égalités contre
	// DOWN, DOWN gagne les égalités contre NEUTRAL (revue PR #27 : la forme
	// précédente laissait pDown == pNeutral en NEUTRAL).
	if (probabilityUp >= probabilityDown && probabilityUp >= pNeutral) {
		return { bias: "UP", probability: probabilityUp };
	}
	if (probabilityDown >= pNeutral) {
		return { bias: "DOWN", probability: probabilityDown };
	}
	return { bias: "NEUTRAL", probability: pNeutral };
};

const isUnit = (value: number): boolean =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 1;

/**
 * Issue vol-scalée (§9, amendement de §8 pour les lignes v2) : le seuil θ
 * est celui persisté à la production, jamais recalculé (INV 16).
 * Null si entrées invalides.
 */
export const resolveVolScaledOutcome = (
	referenceClose: number,
	outcomeClose: number,
	thresholdBps: number,
): TrendOutcome | null => {
	if (
		!Number.isFinite(referenceClose) ||
		referenceClose <= 0 ||
		!Number.isFinite(outcomeClose) ||
		outcomeClose <= 0 ||
		!Number.isFinite(thresholdBps) ||
		thresholdBps < 0
	) {
		return null;
	}
	const threshold = 1 + thresholdBps / 10_000;
	if (thresholdBps > 0) {
		if (outcomeClose >= referenceClose * threshold) return "UP";
		if (outcomeClose <= referenceClose * (2 - threshold)) return "DOWN";
		return "FLAT";
	}
	// θ = 0 : règle v1 — égalité stricte → FLAT.
	if (outcomeClose > referenceClose) return "UP";
	if (outcomeClose < referenceClose) return "DOWN";
	return "FLAT";
};
