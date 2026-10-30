/**
 * Failover interne du service marché (models/market-source-failover.md) :
 * ordre figé COINBASE → HYPERLIQUID → DYDX, une tentative par source et
 * par requête. Référence de basis : la dernière close Coinbase réussie est
 * écrite en KV (TTL = BASIS_REFERENCE_MAX_AGE_MS) et lue avant de servir
 * un secours perp — sans référence fraîche, jamais servi.
 */

import type { Candle } from "@dodash/domain";
import { TIMEFRAME_MILLISECONDS } from "@dodash/domain";
import {
	assessBasisGate,
	BASIS_REFERENCE_MAX_AGE_MS,
	type MarketSourceFailure,
} from "@dodash/models";
import type { MarketCache } from "./coinbase.js";
import { fetchDydxBookMid, fetchDydxCandles } from "./dydx.js";
import { fetchHyperliquidCandles, fetchHyperliquidMid } from "./hyperliquid.js";

export interface BasisReference {
	readonly close: number;
	readonly candleStart: number;
	readonly fetchedAt: number;
}

const basisKey = (productId: string, timeframe: string): string =>
	`basis:ref:${productId}:${timeframe}`;

export const writeBasisReference = async (
	cache: MarketCache,
	productId: string,
	timeframe: string,
	candles: readonly Candle[],
): Promise<void> => {
	const latest = candles[candles.length - 1];
	if (latest === undefined) return;
	const reference: BasisReference = {
		close: latest.close,
		candleStart: latest.start,
		fetchedAt: Date.now(),
	};
	await cache
		.put(basisKey(productId, timeframe), JSON.stringify(reference), {
			expirationTtl: Math.ceil(BASIS_REFERENCE_MAX_AGE_MS / 1000),
		})
		.catch(() => undefined);
};

export const readBasisReference = async (
	cache: MarketCache,
	productId: string,
	timeframe: string,
): Promise<BasisReference | null> => {
	const raw = await cache.get(basisKey(productId, timeframe)).catch(() => null);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as BasisReference;
		if (
			!Number.isFinite(parsed.close) ||
			parsed.close <= 0 ||
			!Number.isSafeInteger(parsed.candleStart) ||
			!Number.isSafeInteger(parsed.fetchedAt)
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
};

export interface BackupCandleOutcome {
	readonly ok: boolean;
	readonly failure?: MarketSourceFailure;
	readonly candles?: readonly Candle[];
}

/**
 * Un secours perp : bougies puis gate de basis sur la dernière close,
 * comparée à la référence Coinbase au même start (jamais un ticker).
 */
export const serveBackupCandles = async (
	source: "HYPERLIQUID" | "DYDX",
	request: {
		productId: string;
		timeframe: string;
		limit: number;
		endMs: number;
	},
	cache: MarketCache,
	deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<BackupCandleOutcome> => {
	const timeframeMs =
		TIMEFRAME_MILLISECONDS[
			request.timeframe as keyof typeof TIMEFRAME_MILLISECONDS
		];
	if (timeframeMs === undefined)
		return { ok: false, failure: "INVALID_RESPONSE" };
	const fetched =
		source === "HYPERLIQUID"
			? await fetchHyperliquidCandles(
					{
						productId: request.productId,
						timeframe: request.timeframe as never,
						limit: request.limit,
						endMs: request.endMs,
					},
					deps,
				)
			: await fetchDydxCandles(
					{
						productId: request.productId,
						timeframe: request.timeframe as never,
						limit: request.limit,
						endMs: request.endMs,
					},
					deps,
				);
	if (!fetched.ok) {
		return { ok: false, failure: mapTransportError(fetched.error) };
	}
	const latest = fetched.value[fetched.value.length - 1];
	if (latest === undefined) return { ok: false, failure: "STALE_SERIES" };
	const reference = await readBasisReference(
		cache,
		request.productId,
		request.timeframe,
	);
	if (reference === null) {
		// INV 3 : sans référence Coinbase fraîche, un secours n'est jamais servi.
		return { ok: false, failure: "BASIS_REJECTED" };
	}
	const gate = assessBasisGate({
		backupClose: latest.close,
		backupCandleStart: latest.start,
		referenceClose: reference.close,
		referenceCandleStart: reference.candleStart,
		referenceFetchedAt: reference.fetchedAt,
		now: (deps.now ?? Date.now)(),
	});
	if (!gate.ok) {
		// NO_REFERENCE est volontairement replié dans BASIS_REJECTED : la closed
		// vocabulary MarketSourceFailure n'a pas de NO_REFERENCE, et l'effet
		// attendu est identique (source écartée, fail-closed).
		return { ok: false, failure: "BASIS_REJECTED" };
	}
	return { ok: true, candles: fetched.value };
};

export interface BackupTickerOutcome {
	readonly ok: boolean;
	readonly failure?: MarketSourceFailure;
	readonly price?: number;
	readonly observedAt?: number;
}

export const serveBackupTicker = async (
	source: "HYPERLIQUID" | "DYDX",
	productId: string,
	deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<BackupTickerOutcome> => {
	const fetched =
		source === "HYPERLIQUID"
			? await fetchHyperliquidMid(productId, deps)
			: await fetchDydxBookMid(productId, deps);
	if (!fetched.ok) {
		return { ok: false, failure: mapTransportError(fetched.error) };
	}
	return {
		ok: true,
		price: fetched.value.price,
		observedAt: fetched.value.observedAt,
	};
};

const mapTransportError = (error: {
	readonly code: string;
	readonly status?: number;
}): MarketSourceFailure => {
	switch (error.code) {
		case "RATE_LIMITED":
			return "RATE_LIMITED";
		case "NETWORK_UNAVAILABLE":
			return "NETWORK_UNAVAILABLE";
		case "INVALID_REQUEST":
		case "INVALID_RESPONSE":
			return "INVALID_RESPONSE";
		default:
			return "NETWORK_UNAVAILABLE";
	}
};
