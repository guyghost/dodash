import { describe, expect, it, vi } from "vitest";
import { fetchDydxBookMid, fetchDydxCandles } from "../src/dydx.js";
import { serveBackupCandles } from "../src/failover.js";
import {
	fetchHyperliquidCandles,
	fetchHyperliquidMid,
} from "../src/hyperliquid.js";

const MIN = 60_000;
const endMs = 300 * MIN;

const hyperResponse = (coin: string): string =>
	JSON.stringify([
		{ t: 298 * MIN, o: "100", h: "101", l: "99", c: "100.5", v: "12", s: coin },
		{ t: 299 * MIN, o: "100.5", h: "102", l: "100", c: "101", v: "8", s: coin },
	]);

const mockFetch = (body: string, status = 200) =>
	vi.fn<typeof fetch>(async () => new Response(body, { status }));

describe("hyperliquid transport (§3)", () => {
	it("mappe candleSnapshot : bougies closes uniquement, coin vérifié, tri ascendant", async () => {
		const f = mockFetch(hyperResponse("BTC"));
		const result = await fetchHyperliquidCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			{ fetch: f as unknown as typeof fetch },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.map((c) => c.start)).toEqual([298 * MIN, 299 * MIN]);
			expect(result.value[1]?.close).toBe(101);
		}
		const [, init] =
			(f as unknown as ReturnType<typeof mockFetch>).mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body)).type).toBe("candleSnapshot");
	});

	it("exclut la bougie en formation et rejette un mauvais coin", async () => {
		const withOpen = JSON.stringify([
			...JSON.parse(hyperResponse("BTC")),
			{ t: 300 * MIN, o: 1, h: 2, l: 0.5, c: 1.5, v: 1, s: "BTC" },
		]);
		const closed = await fetchHyperliquidCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 3, endMs },
			{ fetch: mockFetch(withOpen) as unknown as typeof fetch },
		);
		expect(closed.ok && closed.value.length).toBe(2);

		const wrongCoin = await fetchHyperliquidCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			{ fetch: mockFetch(hyperResponse("ETH")) as unknown as typeof fetch },
		);
		expect(wrongCoin).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});

	it("sert le mid allMids avec l'instant du fetch comme observation", async () => {
		const f = mockFetch(JSON.stringify({ BTC: 43250.5, ETH: 2500.25 }));
		const mid = await fetchHyperliquidMid("BTC-USD", {
			fetch: f as unknown as typeof fetch,
			now: () => 42,
		});
		expect(mid).toMatchObject({ ok: true });
		if (mid.ok) {
			expect(mid.value.price).toBe(43250.5);
			expect(mid.value.observedAt).toBe(42);
		}
	});
});

describe("dydx transport (§3)", () => {
	const dydxResponse = JSON.stringify({
		candles: [
			{
				startedAt: new Date(298 * MIN).toISOString(),
				open: "100",
				high: "101",
				low: "99",
				close: "100.5",
				baseTokenVolume: "12",
				ticker: "BTC-USD",
			},
			{
				startedAt: new Date(299 * MIN).toISOString(),
				open: "100.5",
				high: "102",
				low: "100",
				close: "101",
				baseTokenVolume: "8",
				ticker: "BTC-USD",
			},
			{
				startedAt: new Date(300 * MIN).toISOString(),
				open: "1",
				high: "2",
				low: "0.5",
				close: "1.5",
				baseTokenVolume: "1",
				ticker: "BTC-USD",
			},
		],
	});

	it("mappe les bougies, toISO borne exclusive : la bougie en cours est exclue", async () => {
		const result = await fetchDydxCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 3, endMs },
			{ fetch: mockFetch(dydxResponse) as unknown as typeof fetch },
		);
		expect(result.ok && result.value.map((c) => c.start)).toEqual([
			298 * MIN,
			299 * MIN,
		]);
	});

	it("sert le mid carnet et rejette un carnet croisé", async () => {
		const book = mockFetch(
			JSON.stringify({ bids: [{ price: "100" }], asks: [{ price: "101" }] }),
		);
		const mid = await fetchDydxBookMid("BTC-USD", {
			fetch: book as unknown as typeof fetch,
			now: () => 7,
		});
		expect(mid.ok && mid.value.price).toBe(100.5);

		const crossed = mockFetch(
			JSON.stringify({ bids: [{ price: "102" }], asks: [{ price: "101" }] }),
		);
		const bad = await fetchDydxBookMid("BTC-USD", {
			fetch: crossed as unknown as typeof fetch,
		});
		expect(bad).toMatchObject({
			ok: false,
			error: { code: "INVALID_RESPONSE" },
		});
	});
});

describe("failover service — gate de basis (INV 3)", () => {
	const cache = {
		store: new Map<string, string>(),
		async get(key: string) {
			return this.store.get(key) ?? null;
		},
		async put(key: string, value: string, options: { expirationTtl: number }) {
			expect(options.expirationTtl).toBe(600);
			this.store.set(key, value);
		},
	};

	it("ne sert jamais un secours sans référence Coinbase (fail-closed)", async () => {
		const result = await serveBackupCandles(
			"HYPERLIQUID",
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			cache as never,
			{ fetch: mockFetch(hyperResponse("BTC")) as unknown as typeof fetch },
		);
		expect(result).toMatchObject({ ok: false, failure: "BASIS_REJECTED" });
	});

	it("sert le secours quand le basis est dans la borne, rejette au-delà", async () => {
		// Référence : close 100.4 au même start 299 min, fetchée à l'instant 0.
		cache.store.set(
			"basis:ref:BTC-USD:ONE_MINUTE",
			JSON.stringify({ close: 100.4, candleStart: 299 * MIN, fetchedAt: 0 }),
		);
		const okResult = await serveBackupCandles(
			"HYPERLIQUID",
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			cache as never,
			{
				fetch: mockFetch(hyperResponse("BTC")) as unknown as typeof fetch,
				now: () => 60_000,
			},
		);
		expect(okResult.ok).toBe(true);

		// close secours 101 vs référence 99.9 : ~110 bps — accepté (< 200)
		cache.store.set(
			"basis:ref:BTC-USD:ONE_MINUTE",
			JSON.stringify({ close: 99.9, candleStart: 299 * MIN, fetchedAt: 0 }),
		);
		const rejected = await serveBackupCandles(
			"DYDX",
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			cache as never,
			{
				fetch: mockFetch(
					JSON.stringify({
						candles: [
							{
								startedAt: new Date(299 * MIN).toISOString(),
								open: "101",
								high: "103",
								low: "100",
								close: "102",
								baseTokenVolume: "1",
								ticker: "BTC-USD",
							},
						],
					}),
				) as unknown as typeof fetch,
				now: () => 60_000,
			},
		);
		// 102 vs 99.9 ≈ 210 bps → BASIS_REJECTED (source écartée)
		expect(rejected).toMatchObject({ ok: false, failure: "BASIS_REJECTED" });
	});
});

describe("transports — échec de flux après en-têtes 200 (revue PR #27)", () => {
	const brokenStream = vi.fn<typeof fetch>(async () => {
		return {
			ok: true,
			text: async () => {
				throw new Error("stream aborted");
			},
			body: { cancel: async () => undefined },
		} as unknown as Response;
	});

	it("ramène l'échec de body en erreur transport typée, pas en exception", async () => {
		const hl = await fetchHyperliquidCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			{ fetch: brokenStream as unknown as typeof fetch },
		);
		expect(hl).toMatchObject({
			ok: false,
			error: { code: "NETWORK_UNAVAILABLE" },
		});

		const mid = await fetchHyperliquidMid("BTC-USD", {
			fetch: brokenStream as unknown as typeof fetch,
		});
		expect(mid).toMatchObject({
			ok: false,
			error: { code: "NETWORK_UNAVAILABLE" },
		});

		const dydx = await fetchDydxCandles(
			{ productId: "BTC-USD", timeframe: "ONE_MINUTE", limit: 2, endMs },
			{ fetch: brokenStream as unknown as typeof fetch },
		);
		expect(dydx).toMatchObject({
			ok: false,
			error: { code: "NETWORK_UNAVAILABLE" },
		});

		const book = await fetchDydxBookMid("BTC-USD", {
			fetch: brokenStream as unknown as typeof fetch,
		});
		expect(book).toMatchObject({
			ok: false,
			error: { code: "NETWORK_UNAVAILABLE" },
		});
	});
});
