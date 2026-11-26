import { describe, expect, it } from "vitest";
import {
	normalizePaperPositionProtection,
	resolvePaperPositionProtection,
	type PaperPositionProtectionInput,
} from "./paper-position-protection.js";

const input = (
	positionQuantity: number,
	high: number,
	low: number,
): PaperPositionProtectionInput => ({
	positionQuantity,
	averagePrice: 100,
	enteredAt: 1_000,
	candles: [{ start: 2_000, high, low, close: (high + low) / 2 }],
	risk: { stopLossBps: 35, takeProfitBps: 500 },
});

describe("durable paper position protection", () => {
	it.each([1, -1])(
		"retains the favorable extreme after a rolling window and restoration for quantity %s",
		(quantity) => {
			const first = resolvePaperPositionProtection(
				null,
				input(quantity, 101, 99),
			);
			expect(first).not.toBeNull();
			const restored = normalizePaperPositionProtection(
				JSON.parse(JSON.stringify(first)),
			);
			const second = resolvePaperPositionProtection(
				restored,
				input(quantity, 100.4, 99.6),
			);
			expect(second?.extremePrice).toBe(quantity > 0 ? 101 : 99);
			expect(second?.stopLossPrice).toBe(first?.stopLossPrice);
		},
	);

	it.each([1, -1])(
		"does not loosen a stop when ATR increases for quantity %s",
		(quantity) => {
			const original = {
				...input(quantity, 101, 99),
				atr: 0.1,
				risk: {
					stopLossBps: 35,
					takeProfitBps: 500,
					atrStopLossMultiple: 2,
					atrTakeProfitMultiple: 3,
				},
			};
			const first = resolvePaperPositionProtection(null, original);
			const second = resolvePaperPositionProtection(first, {
				...original,
				atr: 5,
			});
			expect(second?.stopLossPrice).toBe(first?.stopLossPrice);
		},
	);

	it("clears a flat position and resets extremes on a new entry or direction", () => {
		const first = resolvePaperPositionProtection(null, input(1, 110, 100));
		expect(
			resolvePaperPositionProtection(first, { ...input(0, 100, 100) }),
		).toBeNull();
		const next = resolvePaperPositionProtection(first, {
			...input(1, 100, 100),
			enteredAt: 3_000,
		});
		expect(next?.extremePrice).toBe(100);
		expect(next?.stopLossPrice).toBeCloseTo(99.65);
		expect(
			resolvePaperPositionProtection(first, input(-1, 100, 100))?.side,
		).toBe("SHORT");
	});

	it("rejects absent and malformed persisted plans", () => {
		const valid = resolvePaperPositionProtection(null, input(1, 101, 100));
		expect(normalizePaperPositionProtection(undefined)).toBeNull();
		expect(
			normalizePaperPositionProtection({ ...valid, extremePrice: Number.NaN }),
		).toBeNull();
		expect(
			normalizePaperPositionProtection({ ...valid, enteredAt: -1 }),
		).toBeNull();
		expect(
			normalizePaperPositionProtection({
				...valid,
				side: "SHORT",
				extremePrice: 101,
			}),
		).toBeNull();
	});

	it.each([1, -1])(
		"does not prematurely tighten initial stopLossPrice when ATR decreases before trailing activates (v10 INV-AR11) for quantity %s",
		(quantity) => {
			const entry = {
				...input(quantity, 100.2, 99.8),
				atr: 1.0,
				risk: {
					stopLossBps: 50,
					takeProfitBps: 150,
					atrStopLossMultiple: 1.8,
					atrTakeProfitMultiple: 3.5,
				},
			};
			const first = resolvePaperPositionProtection(null, entry);
			expect(first).not.toBeNull();
			// Initial stop should be ~1.8 away (98.2 for LONG, 101.8 for SHORT), not 0.5
			expect(first?.stopLossPrice).toBeCloseTo(quantity > 0 ? 98.2 : 101.8);
			// Next candle: ATR drops to 0.1, trade is still flat (peakGainBps < 75)
			const second = resolvePaperPositionProtection(first, {
				...entry,
				atr: 0.1,
			});
			expect(second?.stopLossPrice).toBeCloseTo(first!.stopLossPrice);
		},
	);

	it("includes the first post-entry 5m candle whose close is strictly after enteredAt while excluding the entry candle (v10 INV-AR12)", () => {
		const FIVE_MIN = 300_000;
		const entryStart = 1_700_000_100_000;
		const enteredAt = entryStart + FIVE_MIN + 8_500; // staggered trigger 8.5s after candle close
		const firstPostStart = entryStart + FIVE_MIN;
		const result = resolvePaperPositionProtection(null, {
			positionQuantity: 1,
			averagePrice: 100,
			enteredAt,
			timeframeMs: FIVE_MIN,
			candles: [
				// Entry candle [T0, T0+5m): spike to 105 BEFORE entry must be ignored
				{ start: entryStart, high: 105, low: 99, close: 100 },
				// First post-entry candle [T0+5m, T0+10m): spike to 101.2 AFTER entry must be captured
				{ start: firstPostStart, high: 101.2, low: 99.9, close: 100.5 },
			],
			risk: { stopLossBps: 50, takeProfitBps: 150 },
		});
		expect(result?.extremePrice).toBe(101.2);
	});
});
