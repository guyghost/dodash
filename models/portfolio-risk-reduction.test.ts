import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { multiProductPortfolioMachine } from "./multi-product-portfolio.machine.js";

const portfolio = () => {
	const actor = createActor(multiProductPortfolioMachine, {
		input: {
			products: ["BTC-USD", "ETH-USD"],
			limits: { maxGrossExposure: 50, maxDailyLoss: 10 },
		},
	}).start();
	actor.send({ type: "PORTFOLIO_STARTED" });
	for (const productId of ["BTC-USD", "ETH-USD"]) {
		actor.send({
			type: "PRODUCT_EXPOSURE_REPORTED",
			productId,
			grossExposure: 100,
			dailyPnl: -20,
		});
	}
	return actor;
};

describe("consolidated position reductions", () => {
	it.each([
		{ currentQuantity: 2, projectedQuantity: 1 },
		{ currentQuantity: -2, projectedQuantity: -1 },
		{ currentQuantity: 2, projectedQuantity: 0 },
		{ currentQuantity: -2, projectedQuantity: 0 },
	])(
		"admits reduction $currentQuantity to $projectedQuantity while daily loss and exposure remain exceeded",
		(positionChange) => {
			const actor = portfolio();
			actor.send({
				type: "RISK_PROPOSED",
				productId: "BTC-USD",
				proposedGrossExposure: Math.abs(positionChange.projectedQuantity) * 100,
				positionChange,
			});
			expect(actor.getSnapshot().context.lastDecision?.approved).toBe(true);
			actor.stop();
		},
	);

	it.each([
		{ currentQuantity: 2, projectedQuantity: -1 },
		{ currentQuantity: 2, projectedQuantity: 3 },
		{ currentQuantity: 2, projectedQuantity: Number.NaN },
	])("rejects an inversion, increase or invalid change", (positionChange) => {
		const actor = portfolio();
		actor.send({
			type: "RISK_PROPOSED",
			productId: "BTC-USD",
			proposedGrossExposure: 100,
			positionChange,
		});
		expect(actor.getSnapshot().context.lastDecision?.approved).toBe(false);
		actor.stop();
	});

	it("keeps kill switch and terminal product priority over a reduction", () => {
		for (const terminal of [
			"PRODUCT_STOPPED",
			"KILL_SWITCH_ENGAGED",
		] as const) {
			const actor = portfolio();
			if (terminal === "PRODUCT_STOPPED")
				actor.send({ type: terminal, productId: "BTC-USD" });
			else actor.send({ type: terminal, controlId: "kill" });
			actor.send({
				type: "RISK_PROPOSED",
				productId: "BTC-USD",
				proposedGrossExposure: 0,
				positionChange: { currentQuantity: 1, projectedQuantity: 0 },
			});
			expect(actor.getSnapshot().context.lastDecision?.approved).toBe(false);
			actor.stop();
		}
	});
});
