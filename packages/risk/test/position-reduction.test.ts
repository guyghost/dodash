import { createOrderIntent, createProductId } from "@dodash/domain";
import { describe, expect, it } from "vitest";
import { evaluatePortfolioRisk } from "../src/portfolio.js";

const configuration = {
	maxOrderNotional: 1_000,
	maxPositionNotional: 1_000,
	maxGrossExposure: 2_000,
	maxDailyLoss: 10,
	cooldownMs: 60_000,
	stopLossBps: 35,
	takeProfitBps: 500,
	allowShort: true,
};

describe("portfolio risk reduction parity", () => {
	it.each([1, -1])(
		"allows partial and full reductions despite exceeded consolidated limits for side %s",
		(direction) => {
			for (const quantity of [1, 2]) {
				const productId = createProductId("BTC-USD");
				if (!productId.ok) throw new Error("invalid product");
				const intent = createOrderIntent({
					productId: productId.value,
					clientOrderId: `reduce:${direction}:${quantity}`,
					decisionId: "reduce",
					strategyIds: ["ema-cross"],
					side: direction > 0 ? "SELL" : "BUY",
					type: "MARKET",
					quantity,
					limitPrice: null,
				});
				if (!intent.ok) throw new Error("invalid order");
				const result = evaluatePortfolioRisk(
					[
						{
							productId: "BTC-USD",
							intent: intent.value,
							config: configuration,
							snapshot: {
								marketPrice: 100,
								currentPositionQuantity: direction * 2,
								otherExposureNotional: 0,
								dailyPnl: -50,
								lastTradeAt: 1_000,
								now: 1_001,
								killSwitchActive: false,
							},
						},
					],
					{ maxGrossExposure: 50, maxDailyLoss: 10 },
				);
				expect(result.ok).toBe(true);
				if (result.ok)
					expect(result.value.decisions[0]?.decision.status).toBe("APPROVED");
			}
		},
	);

	it("still rejects a reducing order under kill switch", () => {
		const productId = createProductId("BTC-USD");
		if (!productId.ok) throw new Error("invalid product");
		const intent = createOrderIntent({
			productId: productId.value,
			clientOrderId: "kill-reduction",
			decisionId: "kill",
			strategyIds: ["ema-cross"],
			side: "SELL",
			type: "MARKET",
			quantity: 1,
			limitPrice: null,
		});
		if (!intent.ok) throw new Error("invalid order");
		const result = evaluatePortfolioRisk(
			[
				{
					productId: "BTC-USD",
					intent: intent.value,
					config: configuration,
					snapshot: {
						marketPrice: 100,
						currentPositionQuantity: 1,
						otherExposureNotional: 0,
						dailyPnl: -50,
						lastTradeAt: null,
						now: 1_001,
						killSwitchActive: true,
					},
				},
			],
			{ maxGrossExposure: 50, maxDailyLoss: 10 },
		);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.decisions[0]?.decision).toEqual({
			status: "REJECTED",
			reasonCode: "KILL_SWITCH_ACTIVE",
		});
	});
});
