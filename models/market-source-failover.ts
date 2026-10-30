/**
 * Market source failover (models/market-source-failover.md).
 *
 * Pure resolution: fixed deployment order COINBASE → HYPERLIQUID → DYDX,
 * one attempt per source per request — the trading machine stays the sole
 * owner of retries (market-retry-schedule.md). A perp backup is never
 * served without a fresh Coinbase close reference within BASIS_MAX_BPS
 * (same candle start); no reference means fail-closed.
 */

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

/** Âge maximal de la référence Coinbase pour la gate de basis. */
export const BASIS_REFERENCE_MAX_AGE_MS = 600_000;

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
 * Gate de basis (§2) : comparaison close↔close au **même start de bougie**,
 * référence Coinbase fraîche (< BASIS_REFERENCE_MAX_AGE_MS). Toute entrée
 * invalide, désalignée ou périmée ⇒ NO_REFERENCE : un secours perp n'est
 * jamais servi sans référence valide.
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
