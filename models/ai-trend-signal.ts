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
