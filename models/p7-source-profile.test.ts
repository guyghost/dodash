import { expect, it } from "vitest";
import { evaluateP7SourceCandidate } from "./p7-source-profile.js";
const close = Date.UTC(2026, 9, 15);
const scope = {
	productId: "BTC-USD" as const,
	sourceProfileId: "candidate",
	clockVerified: true,
	campaignStartAt: close,
	campaignEndAt: close + 180 * 86400000,
	candleClosedAt: close,
	intentPersistedAt: close + 1,
	previousSequence: null,
};
const input = {
	scope,
	auctionMode: false,
	product: {
		id: "BTC-USD",
		base_increment: "0.0001",
		quote_increment: "0.01",
		base_min_size: "0.001",
		min_market_funds: "1",
	},
	requiredBaseQuantity: 1,
	book: {
		productId: "BTC-USD",
		sourceProfileId: "candidate",
		cacheStatus: "UNCACHED",
		requestedAt: close + 1,
		receivedAt: close + 2,
		sourceObservedAt: close + 2,
		sequence: "100",
		bids: [{ price: 99, quantity: 1 }],
		asks: [{ price: 101, quantity: 1 }],
	},
};
it("pure model alone owns candidate metadata, auction, clock, cache and depth decisions", () => {
	expect(evaluateP7SourceCandidate(input).qualified).toBe(true);
	for (const patch of [
		{ auctionMode: null },
		{ product: {} },
		{ requiredBaseQuantity: 2 },
		{ scope: { ...scope, clockVerified: false } },
		{ book: { ...input.book, cacheStatus: "UNKNOWN" } },
	])
		expect(evaluateP7SourceCandidate({ ...input, ...patch }).qualified).toBe(
			false,
		);
});
