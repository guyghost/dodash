import type { Candle } from "@dodash/domain";
import { describe, expect, it } from "vitest";

import {
	computeIndicators,
	DEFAULT_INDICATOR_CONFIG,
	type IndicatorConfig,
	requiredIndicatorCandles,
	type RsiMode,
} from "../src/index.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
	closes.map((close, index) => ({
		start: index * 60_000,
		open: close,
		high: close + 1,
		low: Math.max(0.01, close - 1),
		close,
		volume: 10,
	}));

const baseConfig: IndicatorConfig = {
	rsiPeriod: 3,
	emaFastPeriod: 2,
	emaSlowPeriod: 4,
	atrPeriod: 3,
	historicalVolatilityPeriod: 3,
	momentumPeriod: 2,
	returnPeriods: [1, 2],
	vwapPeriod: 3,
	relativeVolumePeriod: 2,
	volumeSpikeThreshold: 2,
	volumeTrendPeriod: 3,
	trendStrengthPeriod: 3,
};

const referenceWilderRsi = (
	closes: readonly number[],
	period: number,
): number => {
	const deltas: number[] = [];
	for (let i = 1; i < closes.length; i += 1) {
		deltas.push((closes[i] ?? 0) - (closes[i - 1] ?? 0));
	}
	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 0; i < period; i += 1) {
		const d = deltas[i] ?? 0;
		if (d >= 0) avgGain += d;
		else avgLoss += -d;
	}
	avgGain /= period;
	avgLoss /= period;
	for (let i = period; i < deltas.length; i += 1) {
		const d = deltas[i] ?? 0;
		const gain = d >= 0 ? d : 0;
		const loss = d < 0 ? -d : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
	}
	if (avgGain === 0 && avgLoss === 0) return 50;
	if (avgLoss === 0) return 100;
	if (avgGain === 0) return 0;
	const rs = avgGain / avgLoss;
	return 100 - 100 / (1 + rs);
};

const referenceWilderAdx = (
	candles: readonly Candle[],
	period: number,
): { readonly adx: number; readonly plusDi: number; readonly minusDi: number } => {
	const step = (prev: Candle, curr: Candle) => {
		const tr = Math.max(
			curr.high - curr.low,
			Math.abs(curr.high - prev.close),
			Math.abs(curr.low - prev.close),
		);
		const upMove = curr.high - prev.high;
		const downMove = prev.low - curr.low;
		const plus = upMove > downMove && upMove > 0 ? upMove : 0;
		const minus = downMove > upMove && downMove > 0 ? downMove : 0;
		return { tr, plus, minus };
	};
	const dx = (tr: number, plus: number, minus: number): number => {
		if (tr === 0) return 0;
		const sum = plus + minus;
		if (sum === 0) return 0;
		const pdi = (100 * plus) / tr;
		const ndi = (100 * minus) / tr;
		return (100 * Math.abs(pdi - ndi)) / (pdi + ndi);
	};

	let trSum = 0;
	let plusSum = 0;
	let minusSum = 0;
	for (let i = 1; i <= period; i += 1) {
		const s = step(candles[i - 1] as Candle, candles[i] as Candle);
		trSum += s.tr;
		plusSum += s.plus;
		minusSum += s.minus;
	}
	let smoothedTr = trSum / period;
	let smoothedPlus = plusSum / period;
	let smoothedMinus = minusSum / period;
	let dxSum = dx(smoothedTr, smoothedPlus, smoothedMinus);

	for (let i = period + 1; i < 2 * period; i += 1) {
		const s = step(candles[i - 1] as Candle, candles[i] as Candle);
		smoothedTr = (smoothedTr * (period - 1) + s.tr) / period;
		smoothedPlus = (smoothedPlus * (period - 1) + s.plus) / period;
		smoothedMinus = (smoothedMinus * (period - 1) + s.minus) / period;
		dxSum += dx(smoothedTr, smoothedPlus, smoothedMinus);
	}
	let adx = dxSum / period;

	for (let i = 2 * period; i < candles.length; i += 1) {
		const s = step(candles[i - 1] as Candle, candles[i] as Candle);
		smoothedTr = (smoothedTr * (period - 1) + s.tr) / period;
		smoothedPlus = (smoothedPlus * (period - 1) + s.plus) / period;
		smoothedMinus = (smoothedMinus * (period - 1) + s.minus) / period;
		const currDx = dx(smoothedTr, smoothedPlus, smoothedMinus);
		adx = (adx * (period - 1) + currDx) / period;
	}

	const plusDi = smoothedTr === 0 ? 0 : (100 * smoothedPlus) / smoothedTr;
	const minusDi = smoothedTr === 0 ? 0 : (100 * smoothedMinus) / smoothedTr;
	return { adx, plusDi, minusDi };
};

describe("Qualité mathématique des indicateurs (Amendement 2026-11-15)", () => {
	it("INV-M1 : préserve la rétrocompatibilité bit-exacte V1 sans options", async () => {
		const candles = candlesFromCloses(
			Array.from({ length: 32 }, (_, i) => 100 + Math.sin(i * 0.5) * 5 + i * 0.2),
		);
		const baseline = await computeIndicators(candles, DEFAULT_INDICATOR_CONFIG);
		expect(baseline.ok).toBe(true);
		if (!baseline.ok) return;

		expect("plusDi" in baseline.value).toBe(false);
		expect("minusDi" in baseline.value).toBe(false);
		expect("longSma" in baseline.value).toBe(false);

		const cutlerExplicit = await computeIndicators(candles, {
			...DEFAULT_INDICATOR_CONFIG,
			rsiMode: "CUTLER",
		});
		expect(cutlerExplicit.ok).toBe(true);
		if (!cutlerExplicit.ok) return;
		expect(cutlerExplicit.value.rsi).toBe(baseline.value.rsi);
		expect(cutlerExplicit.value.trendStrength).toBe(baseline.value.trendStrength);
	});

	it("INV-M3 : rsiMode WILDER applique le lissage de Wilder et diverge de CUTLER", async () => {
		const closes = [100, 102, 101, 104, 103, 107, 105, 108, 106, 109];
		const candles = candlesFromCloses(closes);

		const cutler = await computeIndicators(candles, {
			...baseConfig,
			rsiMode: "CUTLER",
		});
		const wilder = await computeIndicators(candles, {
			...baseConfig,
			rsiMode: "WILDER",
		});

		expect(cutler.ok).toBe(true);
		expect(wilder.ok).toBe(true);
		if (!cutler.ok || !wilder.ok) return;

		const expectedWilder = referenceWilderRsi(closes, baseConfig.rsiPeriod);
		expect(wilder.value.rsi).toBeCloseTo(expectedWilder, 10);
		expect(wilder.value.rsi).not.toBeCloseTo(cutler.value.rsi, 4);
		expect(wilder.value.rsi).toBeGreaterThanOrEqual(0);
		expect(wilder.value.rsi).toBeLessThanOrEqual(100);
	});

	it("INV-M3 : rsiMode WILDER gère les cas limites (plat=50, hausse=100, baisse=0)", async () => {
		const flat = await computeIndicators(
			candlesFromCloses([10, 10, 10, 10, 10, 10, 10, 10]),
			{ ...baseConfig, rsiMode: "WILDER" },
		);
		const up = await computeIndicators(
			candlesFromCloses([10, 11, 12, 13, 14, 15, 16, 17]),
			{ ...baseConfig, rsiMode: "WILDER" },
		);
		const down = await computeIndicators(
			candlesFromCloses([20, 19, 18, 17, 16, 15, 14, 13]),
			{ ...baseConfig, rsiMode: "WILDER" },
		);

		expect(flat.ok && flat.value.rsi).toBe(50);
		expect(up.ok && up.value.rsi).toBe(100);
		expect(down.ok && down.value.rsi).toBe(0);
	});

	it("INV-M2 : adxWarmupMultiplier >= 3 active adx_continue et expose +DI / -DI", async () => {
		// Série oscillante puis haussière pour que adx_continue (P étapes) diverge de la SMA initiale (2*P)
		const closes = [100, 99, 101, 98, 102, 97, 103, 105, 108, 112, 116, 120];
		const candles = candlesFromCloses(closes);

		const window2 = await computeIndicators(candles, {
			...baseConfig,
			adxWarmupMultiplier: 2,
		});
		const window4 = await computeIndicators(candles, {
			...baseConfig,
			adxWarmupMultiplier: 4,
		});

		expect(window2.ok).toBe(true);
		expect(window4.ok).toBe(true);
		if (!window2.ok || !window4.ok) return;

		const expected4 = referenceWilderAdx(candles, baseConfig.trendStrengthPeriod);
		expect(window4.value.trendStrength).toBeCloseTo(expected4.adx, 10);
		expect(window4.value.plusDi).toBeCloseTo(expected4.plusDi, 10);
		expect(window4.value.minusDi).toBeCloseTo(expected4.minusDi, 10);
		// adx_continue a bien modifié trendStrength par rapport à la fenêtre 2*P
		expect(window4.value.trendStrength).not.toBeCloseTo(
			window2.value.trendStrength,
			4,
		);
		// Fin de série haussière ⇒ +DI > -DI
		expect(window4.value.plusDi).toBeGreaterThan(window4.value.minusDi ?? 0);
	});

	it("INV-M2 : +DI et -DI sont cohérents en tendance baissière et sur marché plat", async () => {
		const downCandles = candlesFromCloses([
			120, 118, 116, 114, 112, 110, 108, 106, 104,
		]);
		const downResult = await computeIndicators(downCandles, {
			...baseConfig,
			adxWarmupMultiplier: 3,
		});
		expect(downResult.ok).toBe(true);
		if (!downResult.ok) return;
		expect(downResult.value.minusDi).toBeGreaterThan(
			downResult.value.plusDi ?? 0,
		);

		const flatCandles = Array.from({ length: 9 }, (_, i) => ({
			start: i * 60_000,
			open: 100,
			high: 100,
			low: 100,
			close: 100,
			volume: 10,
		}));
		const flatResult = await computeIndicators(flatCandles, {
			...baseConfig,
			adxWarmupMultiplier: 3,
		});
		expect(flatResult.ok).toBe(true);
		if (!flatResult.ok) return;
		expect(flatResult.value.trendStrength).toBe(0);
		expect(flatResult.value.plusDi).toBe(0);
		expect(flatResult.value.minusDi).toBe(0);
	});

	it("INV-M4 : longSmaPeriod calcule la SMA exacte et étend requiredIndicatorCandles", async () => {
		const cfg: IndicatorConfig = {
			...baseConfig,
			longSmaPeriod: 12,
		};
		expect(requiredIndicatorCandles(cfg)).toBe(12);

		const shortResult = await computeIndicators(
			candlesFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
			cfg,
		);
		expect(shortResult).toEqual({
			ok: false,
			error: { code: "INSUFFICIENT_CANDLES", required: 12, actual: 11 },
		});

		const closes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140];
		const okResult = await computeIndicators(candlesFromCloses(closes), cfg);
		expect(okResult.ok).toBe(true);
		if (!okResult.ok) return;
		const last12 = closes.slice(-12);
		const expectedSma = last12.reduce((a, b) => a + b, 0) / 12;
		expect(okResult.value.longSma).toBeCloseTo(expectedSma, 10);
	});

	it("rejette avec INVALID_CONFIG toute option mathématique hors domaine", async () => {
		const candles = candlesFromCloses(Array.from({ length: 15 }, (_, i) => 10 + i));
		const invalidConfigs: readonly IndicatorConfig[] = [
			{ ...baseConfig, adxWarmupMultiplier: 1 },
			{ ...baseConfig, adxWarmupMultiplier: 0 },
			{ ...baseConfig, adxWarmupMultiplier: 2.5 },
			{ ...baseConfig, longSmaPeriod: 0 },
			{ ...baseConfig, longSmaPeriod: -3 },
			{ ...baseConfig, longSmaPeriod: 4.5 },
			{ ...baseConfig, rsiMode: "INVALID" as unknown as RsiMode },
		];

		for (const candidate of invalidConfigs) {
			const result = await computeIndicators(candles, candidate);
			expect(result).toEqual({ ok: false, error: { code: "INVALID_CONFIG" } });
		}
	});
});
