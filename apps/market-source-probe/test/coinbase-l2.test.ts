import { describe, expect, it } from "vitest";
import { qualifyCoinbaseL2 } from "../src/coinbase-l2.js";

const close = Date.UTC(2026, 9, 15);
const scope = {
	productId: "BTC-USD" as const,
	sourceProfileId: "coinbase-l2-candidate",
	clockVerified: true,
	campaignStartAt: close,
	campaignEndAt: close + 180 * 86400000,
	candleClosedAt: close,
	intentPersistedAt: close + 1,
	previousSequence: null,
};
const input = () => ({
	scope,
	url: "https://api.exchange.coinbase.com/products/BTC-USD/book?level=2",
	status: 200,
	timedOut: false,
	requestedAt: close + 2,
	receivedAt: close + 100,
	cacheStatus: "UNCACHED",
	requiredBaseQuantity: 2,
	product: {
		id: "BTC-USD",
		base_increment: "0.00000001",
		quote_increment: "0.01",
		base_min_size: "0.0001",
		min_market_funds: "1",
	},
	rawBody: `{"sequence":9007199254740993,"time":"${new Date(close + 50).toISOString()}","auction_mode":false,"bids":[["99.00","2.00",3]],"asks":[["101.00","3.00",5]]}`,
});
describe("offline Coinbase Exchange L2", () => {
	it("preserves exact sequence, tuples, metadata, raw body/hash, aggregated quantities", async () => {
		const f = input();
		const r = await qualifyCoinbaseL2(f);
		expect(r.qualified).toBe(true);
		expect(r.rawBody).toBe(f.rawBody);
		expect(r.bodySha256).toMatch(/^[a-f0-9]{64}$/);
		expect(r.book?.sequence).toBe("9007199254740993");
		expect(r.wire?.bids[0]).toEqual(["99.00", "2.00", 3]);
		expect(r.book?.bids[0]?.quantity).toBe(2);
		expect(r.product).toEqual(f.product);
	});
	it("rejects transport, identity, auction, metadata, cache, clock and depth", async () => {
		const f = input();
		for (const patch of [
			{ status: 429 },
			{ timedOut: true },
			{ url: `${f.url}&extra=1` },
			{ cacheStatus: "UNKNOWN" },
			{ scope: { ...scope, clockVerified: false } },
			{ requiredBaseQuantity: 4 },
			{ product: { ...f.product, min_market_funds: undefined } },
			{ rawBody: f.rawBody.replace("false", "null") },
			{ rawBody: f.rawBody.replace("false", "true") },
			{ rawBody: f.rawBody.replace('"99.00"', '"102.00"') },
			{ rawBody: '{"price":"100"}' },
		])
			expect((await qualifyCoinbaseL2({ ...f, ...patch })).qualified).toBe(
				false,
			);
	});
	it("rejects malformed source timestamps even when envelope matches Date.parse normalization", async () => {
		for (const time of [
			"2026-02-30T00:00:00.000Z",
			"2025-02-29T00:00:00Z",
			"2026-10-15T00:00:00.050",
			"2026-10-15 00:00:00.050Z",
			"2026-10-15T24:00:00Z",
			"2026-10-15T00:00:00+24:00",
			"2026-10-15T00:00:00+01:60",
			"2026-10-15T00:00:00.Z",
			"2026-10-15T00:00:00.050+0200",
			"2026-10-15T00:00:60Z",
		]) {
			const f = input();
			const observedAt = Date.parse(time);
			const instant = Number.isFinite(observedAt) ? observedAt : close + 50;
			const result = await qualifyCoinbaseL2({
				...f,
				scope: {
					...scope,
					campaignStartAt: instant - 100,
					candleClosedAt: instant - 100,
					intentPersistedAt: instant - 99,
					campaignEndAt: instant + 86400000,
				},
				requestedAt: instant - 1,
				receivedAt: instant + 1,
				rawBody: f.rawBody.replace(new Date(close + 50).toISOString(), time),
			});
			expect(result.qualified, time).toBe(false);
			expect(result.sourceObservedAt, time).toBeNull();
		}
	});
	it("accepts valid explicit-offset timestamps and source fractional precision", async () => {
		for (const time of [
			"2026-10-15T00:00:00.050Z",
			"2026-10-15T02:00:00.050+02:00",
			"2026-10-14T19:00:00.050000-05:00",
		]) {
			const f = input();
			const result = await qualifyCoinbaseL2({
				...f,
				rawBody: f.rawBody.replace(new Date(close + 50).toISOString(), time),
			});
			expect(result.qualified, time).toBe(true);
			expect(result.sourceObservedAt).toBe(close + 50);
		}
	});
	it("rejects duplicate keys and nested sequence ambiguity", async () => {
		for (const body of [
			input().rawBody.replace("{", '{"sequence":1,'),
			input().rawBody.replace("{", '{"nested":{"sequence":1},'),
			input().rawBody.replace(
				'"auction_mode":false',
				'"auction_mode":false,"auction_mode":true',
			),
		])
			expect(
				(await qualifyCoinbaseL2({ ...input(), rawBody: body })).qualified,
			).toBe(false);
	});
	it("enforces inclusive 5s freshness/latency and 2h deadline", async () => {
		const f = input();
		for (const [receivedAt, requestedAt, observedAt, expected] of [
			[close + 6000, close + 1000, close + 1000, true],
			[close + 6001, close + 1000, close + 1001, false],
			[close + 6000, close + 5999, close + 999, false],
			[close + 7200000, close + 7199999, close + 7200000, true],
			[close + 7200001, close + 7200000, close + 7200001, false],
		] as const)
			expect(
				(
					await qualifyCoinbaseL2({
						...f,
						receivedAt,
						requestedAt,
						rawBody: f.rawBody.replace(
							new Date(close + 50).toISOString(),
							new Date(observedAt).toISOString(),
						),
					})
				).qualified,
			).toBe(expected);
	});
});
