import { type Candle, validateCandleSeries } from "@dodash/domain";
import { describe, expect, it } from "vitest";
import {
	computeIndicators,
	createIndicatorSeriesComputer,
	DEFAULT_INDICATOR_CONFIG,
	type IndicatorConfig,
	requiredIndicatorCandles,
} from "../src/index.js";

/**
 * INV-27 (models/backtest-run.md §Préparation incrémentale) : les
 * snapshots du computer incrémental sont strictement identiques — tous
 * champs, `snapshotId` compris — à ceux de l'implémentation de référence
 * (`computeIndicators` sur chaque préfixe).
 */

// PRNG déterministe (mulberry32) : la série est reproductible.
const mulberry32 = (seed: number): (() => number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const randomCandles = (count: number, seed: number): Candle[] => {
	const random = mulberry32(seed);
	const candles: Candle[] = [];
	let close = 50_000;
	for (let index = 0; index < count; index += 1) {
		const drift = (random() - 0.5) * 0.04;
		close = Math.max(1, close * (1 + drift));
		const open = Math.max(1, close * (1 + (random() - 0.5) * 0.01));
		const high = Math.max(open, close) * (1 + random() * 0.01);
		const low = Math.min(open, close) * (1 - random() * 0.01);
		const volume = 100 + random() * 900;
		candles.push({
			start: 1_700_000_000_000 + index * 86_400_000,
			open,
			high,
			low,
			close,
			volume,
		});
	}
	return candles;
};

const COMPACT_CONFIG: IndicatorConfig = {
	rsiPeriod: 3,
	emaFastPeriod: 2,
	emaSlowPeriod: 4,
	atrPeriod: 3,
	historicalVolatilityPeriod: 3,
	momentumPeriod: 2,
	returnPeriods: [1, 3],
	vwapPeriod: 3,
	relativeVolumePeriod: 2,
	volumeSpikeThreshold: 1.5,
	volumeTrendPeriod: 3,
	trendStrengthPeriod: 2,
};

const SIGNAL_CONFIG: IndicatorConfig = {
	...COMPACT_CONFIG,
	signalEmaFastPeriod: 2,
	signalEmaSlowPeriod: 6,
};

const assertSeriesIdentical = async (
	candles: readonly Candle[],
	config: IndicatorConfig,
): Promise<void> => {
	const validated = validateCandleSeries(candles);
	if (!validated.ok) throw new Error("invalid generated series");
	const warmup = requiredIndicatorCandles(config);
	const computerResult = await createIndicatorSeriesComputer(config);
	expect(computerResult.ok).toBe(true);
	if (!computerResult.ok) return;
	const computer = computerResult.value;

	for (let index = 0; index < validated.value.length; index += 1) {
		const prefix = validated.value.slice(0, index + 1);
		const reference =
			index < warmup - 1
				? null
				: await computeIndicators(prefix, config).then((result) => {
						expect(result.ok).toBe(true);
						return result.ok ? result.value : null;
					});
		const pushed = await computer.push(validated.value[index] as Candle);
		expect(pushed.ok).toBe(true);
		if (!pushed.ok) return;
		if (reference === null) {
			expect(pushed.value).toBeNull();
		} else {
			expect(pushed.value).toStrictEqual(reference);
			// Verrou explicite sur l'identité du hachage de préfixe.
			expect(pushed.value?.snapshotId).toBe(reference.snapshotId);
		}
	}
};

describe("IndicatorSeriesComputer (INV-27)", () => {
	it("produit des snapshots strictement identiques à la référence (config défaut)", {
		timeout: 300_000,
	}, async () => {
		await assertSeriesIdentical(
			randomCandles(60, 0x37),
			DEFAULT_INDICATOR_CONFIG,
		);
	});

	it("produit des snapshots strictement identiques (config compacte)", async () => {
		await assertSeriesIdentical(randomCandles(40, 0xd0da), COMPACT_CONFIG);
	});

	it("produit des snapshots strictement identiques (paire de signal EMA)", async () => {
		await assertSeriesIdentical(randomCandles(40, 0x5eed), SIGNAL_CONFIG);
	});

	it("produit des snapshots strictement identiques sur une série longue (> 100 snapshots)", {
		timeout: 300_000,
	}, async () => {
		await assertSeriesIdentical(randomCandles(120, 0xbeef), COMPACT_CONFIG);
	});

	it("rend null pendant l'échauffement et s'aligne sur candleClosedAt", async () => {
		const candles = randomCandles(12, 0x1234);
		const computerResult = await createIndicatorSeriesComputer(COMPACT_CONFIG);
		expect(computerResult.ok).toBe(true);
		if (!computerResult.ok) return;
		const warmup = requiredIndicatorCandles(COMPACT_CONFIG);
		const snapshots = [];
		for (const candle of candles) {
			const pushed = await computerResult.value.push(candle);
			expect(pushed.ok).toBe(true);
			if (pushed.ok) snapshots.push(pushed.value);
		}
		expect(snapshots.slice(0, warmup - 1)).toEqual(
			Array.from({ length: warmup - 1 }, () => null),
		);
		expect(
			snapshots.slice(warmup - 1).map((snapshot) => snapshot?.candleClosedAt),
		).toEqual(candles.slice(warmup - 1).map((candle) => candle.start));
	});

	it("rejette une configuration invalide", async () => {
		const result = await createIndicatorSeriesComputer({
			...COMPACT_CONFIG,
			emaFastPeriod: 5,
			emaSlowPeriod: 4,
		});
		expect(result).toStrictEqual({
			ok: false,
			error: { code: "INVALID_CONFIG" },
		});
	});
});
