/**
 * Market source failover (models/market-source-failover.md).
 *
 * Pure resolution: fixed deployment order COINBASE → HYPERLIQUID → DYDX.
 * The trading machine stays the owner of cycle retries
 * (market-retry-schedule.md). Coinbase RATE_LIMITED may be re-attempted
 * inside one request on the bounded plan below; every other failure is
 * one attempt. A perp backup is never served without a Coinbase close
 * that shares a candle start and sits within BASIS_MAX_BPS. The compared
 * candle is that overlapping close, which may be older than the newest
 * backup candle. No overlap or no reference means fail-closed.
 */

import type { CandleCloseMarkSource } from "./paper-valuation.js";

export type MarketSourceId = "COINBASE" | "HYPERLIQUID" | "DYDX";

export type MarketSourceFailure =
	| "RATE_LIMITED"
	| "NETWORK_UNAVAILABLE"
	| "INVALID_RESPONSE"
	| "STALE_SERIES"
	| "BASIS_REJECTED";

/** Ordre figé par déploiement (§2). */
export const MARKET_SOURCE_ORDER: readonly MarketSourceId[] = Object.freeze([
	"COINBASE",
	"HYPERLIQUID",
	"DYDX",
]);

/** Basis perp/spot maximal accepté (revue 2026-10-31). */
export const BASIS_MAX_BPS = 200;

/**
 * How long a Coinbase close may still anchor a perp series.
 *
 * The daily decision runs once, at 00:01 UTC. A reference written then is
 * ~24h old at the next window and ~26h old if that window closes at 02:00.
 * The observed RATE_LIMITED run lasted 7 days, mostly on ETH, so the anchor
 * has to outlive several missed daily closes. 8 days covers that run plus
 * the next freshness window. Age does not measure basis drift: the gate
 * compares one shared candle start. It only bounds how long a spot close
 * may authorize the rest of a perp series.
 */
export const BASIS_REFERENCE_MAX_AGE_MS = 8 * 24 * 3_600_000;

/**
 * In-request Coinbase re-attempts after RATE_LIMITED, before the next
 * source. The machine retry schedule is unchanged and still owns waits
 * longer than this budget.
 */
export const COINBASE_RATE_LIMIT_MAX_ATTEMPTS = 3;
export const COINBASE_RATE_LIMIT_BASE_DELAYS_MS: readonly number[] = Object.freeze([
	400, 1_200,
]);
export const COINBASE_RATE_LIMIT_MAX_DELAY_MS = 1_500;
export const COINBASE_RATE_LIMIT_BUDGET_MS = 2_500;
/** ±25% around the chosen delay. `randomUnit` is injected. */
export const COINBASE_RATE_LIMIT_JITTER_RATIO = 0.25;

export type MarketSourceResolution =
	| { readonly source: MarketSourceId }
	| { readonly exhausted: true };

/**
 * Première source de l'ordre sans échec déclaré. Pure : la carte des
 * échecs est alimentée par la requête courante uniquement (une tentative
 * par source) ; une source absente de la carte est considérée non essayée.
 */
export const resolveMarketSource = (
	order: readonly MarketSourceId[],
	failures: Readonly<Partial<Record<MarketSourceId, MarketSourceFailure>>>,
): MarketSourceResolution => {
	for (const source of order) {
		if (failures[source] == null) {
			return { source };
		}
	}
	return { exhausted: true };
};

export interface BasisGateInput {
	readonly backupClose: number;
	readonly backupCandleStart: number;
	readonly referenceClose: number;
	readonly referenceCandleStart: number;
	readonly referenceFetchedAt: number;
	readonly now: number;
}

export type BasisAssessment =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "NO_REFERENCE" | "BASIS_REJECTED" };

/**
 * Gate de basis (§2) : comparaison close↔close au même start de bougie,
 * référence Coinbase d'âge ≤ BASIS_REFERENCE_MAX_AGE_MS. Toute entrée
 * invalide, désalignée ou périmée ⇒ NO_REFERENCE : un secours perp n'est
 * jamais servi sans référence valide. La borne d'âge est inclusive.
 */
export const assessBasisGate = (input: BasisGateInput): BasisAssessment => {
	const invalid =
		!Number.isFinite(input.backupClose) ||
		input.backupClose <= 0 ||
		!Number.isFinite(input.referenceClose) ||
		input.referenceClose <= 0 ||
		!Number.isSafeInteger(input.backupCandleStart) ||
		!Number.isSafeInteger(input.referenceCandleStart) ||
		!Number.isSafeInteger(input.referenceFetchedAt) ||
		!Number.isSafeInteger(input.now);
	if (invalid) {
		return { ok: false, reason: "NO_REFERENCE" };
	}
	if (input.backupCandleStart !== input.referenceCandleStart) {
		return { ok: false, reason: "NO_REFERENCE" };
	}
	if (input.now - input.referenceFetchedAt > BASIS_REFERENCE_MAX_AGE_MS) {
		return { ok: false, reason: "NO_REFERENCE" };
	}
	const basisBps =
		(Math.abs(input.backupClose - input.referenceClose) /
			input.referenceClose) *
		10_000;
	if (basisBps > BASIS_MAX_BPS) {
		return { ok: false, reason: "BASIS_REJECTED" };
	}
	return { ok: true };
};

export interface BasisCandle {
	readonly start: number;
	readonly close: number;
}

/**
 * Backup candle whose start equals the Coinbase reference. The newest
 * backup close is often the candle Coinbase did not return; it is not
 * the pair the gate compares. No safe overlap → null (fail-closed).
 */
export const findOverlappingBasisCandle = (
	candles: readonly BasisCandle[],
	referenceCandleStart: number,
): BasisCandle | null => {
	if (!Number.isSafeInteger(referenceCandleStart)) return null;
	for (const candle of candles) {
		if (
			candle.start === referenceCandleStart &&
			Number.isFinite(candle.close) &&
			candle.close > 0
		) {
			return candle;
		}
	}
	return null;
};

export type RateLimitBackoffPlan =
	| {
			readonly kind: "retry";
			readonly delayMs: number;
			readonly spentMs: number;
	  }
	| {
			readonly kind: "stop";
			readonly reason: "ATTEMPTS" | "RETRY_AFTER_EXCEEDS_BUDGET" | "BUDGET";
	  };

const jitterScale = (randomUnit: number): number => {
	const unit = Number.isFinite(randomUnit)
		? Math.min(1, Math.max(0, randomUnit))
		: 0;
	return (
		1 -
		COINBASE_RATE_LIMIT_JITTER_RATIO +
		2 * COINBASE_RATE_LIMIT_JITTER_RATIO * unit
	);
};

/**
 * Next in-request wait after a Coinbase RATE_LIMITED, or stop.
 * `attempt` is the 0-based index of the retry about to be scheduled
 * (0 after the first failure). `randomUnit` ∈ [0, 1] is injected so the
 * plan stays pure. Jitter applies to the table delay only. `Retry-After`
 * is a floor: the wait is never shorter than the server cooldown. A floor
 * above the in-request cap stops instead of being clipped; the machine
 * retry schedule owns that wait, and this request fails over.
 */
export const planRateLimitBackoff = (input: {
	readonly attempt: number;
	readonly retryAfterMs: number | null;
	readonly randomUnit: number;
	readonly spentMs: number;
}): RateLimitBackoffPlan => {
	if (
		!Number.isSafeInteger(input.attempt) ||
		input.attempt < 0 ||
		input.attempt >= COINBASE_RATE_LIMIT_MAX_ATTEMPTS - 1
	) {
		return Object.freeze({ kind: "stop", reason: "ATTEMPTS" });
	}
	const table =
		COINBASE_RATE_LIMIT_BASE_DELAYS_MS[
			Math.min(input.attempt, COINBASE_RATE_LIMIT_BASE_DELAYS_MS.length - 1)
		] ?? COINBASE_RATE_LIMIT_MAX_DELAY_MS;
	const retryAfter =
		input.retryAfterMs !== null &&
		Number.isFinite(input.retryAfterMs) &&
		input.retryAfterMs >= 0
			? input.retryAfterMs
			: null;
	const jitteredBase = Math.min(
		Math.round(table * jitterScale(input.randomUnit)),
		COINBASE_RATE_LIMIT_MAX_DELAY_MS,
	);
	if (
		retryAfter !== null &&
		retryAfter > COINBASE_RATE_LIMIT_MAX_DELAY_MS
	) {
		return Object.freeze({ kind: "stop", reason: "RETRY_AFTER_EXCEEDS_BUDGET" });
	}
	const delayMs =
		retryAfter === null ? jitteredBase : Math.max(jitteredBase, retryAfter);
	if (
		!Number.isFinite(input.spentMs) ||
		input.spentMs < 0 ||
		input.spentMs + delayMs > COINBASE_RATE_LIMIT_BUDGET_MS
	) {
		return Object.freeze({ kind: "stop", reason: "BUDGET" });
	}
	return Object.freeze({
		kind: "retry",
		delayMs,
		spentMs: input.spentMs + delayMs,
	});
};

/** Closed mark label for the snapshot source. One series, one label. */
export const candleCloseMarkSource = (
	source: "coinbase" | "hyperliquid" | "dydx",
): CandleCloseMarkSource => {
	switch (source) {
		case "hyperliquid":
			return "HYPERLIQUID_CANDLE_CLOSE";
		case "dydx":
			return "DYDX_CANDLE_CLOSE";
		case "coinbase":
			return "COINBASE_CANDLE_CLOSE";
	}
};
