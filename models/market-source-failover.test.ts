import { describe, expect, it } from "vitest";
import {
	assessBasisGate,
	BASIS_MAX_BPS,
	BASIS_REFERENCE_MAX_AGE_MS,
	MARKET_SOURCE_ORDER,
	type MarketSourceId,
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
});
