import { describe, expect, it } from "vitest";
import {
	projectDashboardPnlHistory,
	type DashboardPnlCycleRow,
	type DashboardPnlOrderRow,
} from "./dashboard-pnl-history.js";

const cycle = (
	cycleId: string,
	at: number,
	side?: "BUY" | "SELL",
	protection?: unknown,
	withRisk = false,
): DashboardPnlCycleRow => ({
	cycleId,
	triggeredAt: at,
	completedAt: at + 1_000,
	outcome: side === undefined ? "NO_ACTION" : "ORDER_CONFIRMED",
	productId: "BTC-USD",
	artifactsJson: JSON.stringify({
		market: {
			productId: "BTC-USD",
			timeframe: "ONE_MINUTE",
			candles: [{ close: 100 }],
			valuationMark: {
				price: 100,
				source: "HYPERLIQUID_CANDLE_CLOSE",
				timeframe: "ONE_MINUTE",
				candleClosedAt: at - 1,
				maxMarketStalenessMs: 90_000,
			},
		},
		...(side === undefined ? {} : { order: { side, quantity: 1 } }),
		...(withRisk
			? {
					risk: { status: "APPROVED", stopLossPrice: 105, takeProfitPrice: 95 },
				}
			: {}),
		...(protection === undefined ? {} : { paperProtection: protection }),
	}),
});

const order = (
	cycleId: string,
	positionQuantity: number,
	averagePrice: number,
): DashboardPnlOrderRow => ({
	clientOrderId: `order:${cycleId}`,
	cycleId,
	status: "CONFIRMED",
	executionJson: JSON.stringify({
		status: "CONFIRMED",
		exchangeOrderId: `exchange:${cycleId}`,
		portfolio: { cash: 1_000, positionQuantity, averagePrice },
		fill: { price: 100, quantity: 1, fee: 0.1 },
	}),
});

describe("paper protection history facts", () => {
	it("exposes a short opening plan without inventing exchange confirmation", () => {
		const result = projectDashboardPnlHistory(
			[cycle("open", 10_001, "SELL", undefined, true)],
			[order("open", -1, 99.9)],
			30,
		);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.openPosition?.quantity).toBe(-1);
		expect(result.value.protection).toEqual({
			stopLossPrice: 105,
			takeProfitPrice: 95,
			protectiveOrderConfirmed: false,
		});
	});

	it("uses the persisted trailing plan on a hold cycle", () => {
		const plan = {
			side: "SHORT",
			averagePrice: 99.9,
			enteredAt: 10_001,
			extremePrice: 99,
			stopLossPrice: 99.5,
			takeProfitPrice: 95,
		};
		const result = projectDashboardPnlHistory(
			[
				cycle("open", 10_001, "SELL", undefined, true),
				cycle("hold", 70_001, undefined, plan),
			],
			[order("open", -1, 99.9)],
			30,
		);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.protection).toEqual({
			stopLossPrice: 99.5,
			takeProfitPrice: 95,
			protectiveOrderConfirmed: false,
		});
	});

	it("does not carry a closed short protection to a new unprotected long", () => {
		const result = projectDashboardPnlHistory(
			[
				cycle("open", 10_001, "SELL", undefined, true),
				cycle("close", 70_001, "BUY"),
				cycle("reopen", 130_001, "BUY"),
			],
			[order("open", -1, 99.9), order("close", 0, 0), order("reopen", 1, 100)],
			30,
		);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.openPosition?.quantity).toBe(1);
		expect(result.value.protection).toBeNull();
	});
});
