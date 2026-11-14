import { describe, expect, it } from "vitest";
import {
	assessBasisGate,
	BASIS_MAX_BPS,
	BASIS_REFERENCE_MAX_AGE_MS,
	candleCloseMarkSource,
	findOverlappingBasisCandle,
	MARKET_SOURCE_ORDER,
	type MarketSourceId,
	planRateLimitBackoff,
	resolveMarketSource,
} from "./market-source-failover.js";

describe("market source failover — résolution (§2)", () => {
	it("sert le primaire sain et ne le contourne jamais", () => {
		expect(resolveMarketSource(MARKET_SOURCE_ORDER, {})).toEqual({
			source: "COINBASE",
		});
		expect(
			resolveMarketSource(MARKET_SOURCE_ORDER, { COINBASE: "RATE_LIMITED" }),
		).toEqual({ source: "HYPERLIQUID" });
		expect(
			resolveMarketSource(MARKET_SOURCE_ORDER, {
				COINBASE: "RATE_LIMITED",
				HYPERLIQUID: "BASIS_REJECTED",
			}),
		).toEqual({ source: "DYDX" });
	});

	it("échoue fermement quand toutes les sources sont épuisées", () => {
		const all: Record<MarketSourceId, "RATE_LIMITED"> = {
			COINBASE: "RATE_LIMITED",
			HYPERLIQUID: "RATE_LIMITED",
			DYDX: "RATE_LIMITED",
		};
		expect(resolveMarketSource(MARKET_SOURCE_ORDER, all)).toEqual({
			exhausted: true,
		});
	});
});

describe("market source failover — gate de basis (§2)", () => {
	const base = {
		backupClose: 100.4,
		backupCandleStart: 1_000,
		referenceClose: 100,
		referenceCandleStart: 1_000,
		referenceFetchedAt: 2_000,
		now: 300_000, // < 10 min
	};

	it("accepte un basis dans la borne (40 bps < 200)", () => {
		expect(assessBasisGate(base)).toEqual({ ok: true });
	});

	it("rejette au-delà de BASIS_MAX_BPS", () => {
		expect(
			assessBasisGate({ ...base, backupClose: 103 }), // 300 bps
		).toEqual({ ok: false, reason: "BASIS_REJECTED" });
		expect(
			assessBasisGate({
				...base,
				backupClose: 100 + (BASIS_MAX_BPS / 10_000) * 100 + 0.001,
			}),
		).toEqual({
			ok: false,
			reason: "BASIS_REJECTED",
		});
	});

	it("jamais servi sans référence valide : âge, désalignement, entrées invalides", () => {
		expect(
			assessBasisGate({
				...base,
				now: base.referenceFetchedAt + BASIS_REFERENCE_MAX_AGE_MS + 1,
			}),
		).toEqual({ ok: false, reason: "NO_REFERENCE" });
		expect(assessBasisGate({ ...base, backupCandleStart: 1_060 })).toEqual({
			ok: false,
			reason: "NO_REFERENCE",
		});
		expect(assessBasisGate({ ...base, referenceClose: -1 })).toEqual({
			ok: false,
			reason: "NO_REFERENCE",
		});
		expect(assessBasisGate({ ...base, referenceClose: Number.NaN })).toEqual({
			ok: false,
			reason: "NO_REFERENCE",
		});
	});

	it("accepte la référence exactement à la borne d'âge (inclusive)", () => {
		expect(
			assessBasisGate({
				...base,
				now: base.referenceFetchedAt + BASIS_REFERENCE_MAX_AGE_MS,
			}),
		).toEqual({ ok: true });
	});

	it("garde une ancre de la décision daily précédente (24 h)", () => {
		expect(
			assessBasisGate({
				...base,
				now: base.referenceFetchedAt + 24 * 3_600_000,
			}),
		).toEqual({ ok: true });
	});
});

describe("market source failover — recouvrement et backoff (2026-11-14)", () => {
	it("retient la bougie au start de la référence, pas la plus récente", () => {
		const candles = [
			{ start: 0, close: 100.4 },
			{ start: 86_400_000, close: 130 },
		];
		expect(findOverlappingBasisCandle(candles, 0)).toEqual(candles[0]);
		expect(findOverlappingBasisCandle(candles, 86_400_000)).toEqual(candles[1]);
		expect(findOverlappingBasisCandle(candles, 1)).toBeNull();
		expect(findOverlappingBasisCandle([{ start: 0, close: 0 }], 0)).toBeNull();
	});

	it("réessaie Coinbase avec une gigue déterministe, puis s'arrête", () => {
		expect(
			planRateLimitBackoff({
				attempt: 0,
				retryAfterMs: null,
				randomUnit: 0,
				spentMs: 0,
			}),
		).toEqual({ kind: "retry", delayMs: 300, spentMs: 300 });
		expect(
			planRateLimitBackoff({
				attempt: 0,
				retryAfterMs: null,
				randomUnit: 0.5,
				spentMs: 0,
			}),
		).toEqual({ kind: "retry", delayMs: 400, spentMs: 400 });
		expect(
			planRateLimitBackoff({
				attempt: 0,
				retryAfterMs: null,
				randomUnit: 1,
				spentMs: 0,
			}),
		).toEqual({ kind: "retry", delayMs: 500, spentMs: 500 });
		expect(
			planRateLimitBackoff({
				attempt: 1,
				retryAfterMs: null,
				randomUnit: 0.5,
				spentMs: 400,
			}),
		).toEqual({ kind: "retry", delayMs: 1_200, spentMs: 1_600 });
		expect(
			planRateLimitBackoff({
				attempt: 2,
				retryAfterMs: null,
				randomUnit: 0.5,
				spentMs: 1_600,
			}),
		).toEqual({ kind: "stop", reason: "ATTEMPTS" });
	});

	it("n'attend pas dans la requête quand Retry-After dépasse le plafond", () => {
		expect(
			planRateLimitBackoff({
				attempt: 0,
				retryAfterMs: 9_000,
				randomUnit: 0.5,
				spentMs: 0,
			}),
		).toEqual({ kind: "stop", reason: "RETRY_AFTER_EXCEEDS_BUDGET" });
	});

	it("respecte le budget cumulé", () => {
		expect(
			planRateLimitBackoff({
				attempt: 1,
				retryAfterMs: 1_500,
				randomUnit: 0.5,
				spentMs: 1_500,
			}),
		).toEqual({ kind: "stop", reason: "BUDGET" });
	});

	it("étiquette le mark par la source de la série", () => {
		expect(candleCloseMarkSource("coinbase")).toBe("COINBASE_CANDLE_CLOSE");
		expect(candleCloseMarkSource("hyperliquid")).toBe(
			"HYPERLIQUID_CANDLE_CLOSE",
		);
		expect(candleCloseMarkSource("dydx")).toBe("DYDX_CANDLE_CLOSE");
	});
});
