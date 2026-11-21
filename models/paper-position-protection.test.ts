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
});
