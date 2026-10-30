/**
 * dYdX v4 perp transport (models/market-source-failover.md §3, sémantiques
 * du comparateur) : bougies avec `toISO` fixé à la clôture de fenêtre
 * (borne de start exclusive observée), bougie en cours toujours exclue ;
 * prix = moyenne du meilleur bid/ask non croisé. Public, User-Agent
 * transparent, redirects refusés, ≤ 2 MiB, timeout 10 s. BTC/ETH initial.
 */
import {
	type Candle,
	createCandle,
	err,
	ok,
	type Result,
	TIMEFRAME_MILLISECONDS,
	type Timeframe,
} from "@dodash/domain";
import { z } from "zod";
import type { MarketDataError } from "./coinbase.js";

const DYDX_INDEXER_URL = "https://indexer.dydx.trade/v4";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "dodash-market-data/0.1 (diagnostic; contact: guyghost)";

const numeric = z
	.union([z.number(), z.string().trim().min(1)])
	.transform(Number)
	.pipe(z.number().finite());

const candlesSchema = z.object({
	candles: z
		.array(
			z.object({
				startedAt: z.string(),
				open: numeric,
				high: numeric,
				low: numeric,
				close: numeric,
				baseTokenVolume: numeric,
				ticker: z.string(),
			}),
		)
		.max(5000),
});

const bookSchema = z.object({
	bids: z
		.array(z.object({ price: numeric }))
		.min(1)
		.max(5000),
	asks: z
		.array(z.object({ price: numeric }))
		.min(1)
		.max(5000),
});

const RESOLUTION_BY_TIMEFRAME: Readonly<Record<Timeframe, string>> =
	Object.freeze({
		ONE_MINUTE: "1MIN",
		FIVE_MINUTE: "5MIN",
		FIFTEEN_MINUTE: "15MIN",
		ONE_HOUR: "1HOUR",
		SIX_HOUR: "6HOUR",
		ONE_DAY: "1DAY",
	});

import type { BackupCandleRequest } from "./hyperliquid.js";

export interface DydxDeps {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

const invalidResponse: MarketDataError = { code: "INVALID_RESPONSE" };
const networkUnavailable: MarketDataError = { code: "NETWORK_UNAVAILABLE" };

export const fetchDydxCandles = async (
	request: BackupCandleRequest,
	deps: DydxDeps = {},
): Promise<Result<readonly Candle[], MarketDataError>> => {
	const duration = TIMEFRAME_MILLISECONDS[request.timeframe];
	const fetcher = deps.fetch ?? fetch;
	const params = new URLSearchParams({
		resolution: RESOLUTION_BY_TIMEFRAME[request.timeframe],
		// toISO = clôture de fenêtre : borne de start exclusive observée.
		fromISO: new Date(request.endMs - request.limit * duration).toISOString(),
		toISO: new Date(request.endMs).toISOString(),
		limit: String(Math.min(request.limit, 100)),
	});
	let response: Response;
	try {
		response = await fetcher(
			`${DYDX_INDEXER_URL}/candles/perpetualMarkets/${encodeURIComponent(request.productId)}?${params}`,
			{
				headers: { accept: "application/json", "user-agent": USER_AGENT },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			},
		);
	} catch {
		return err(networkUnavailable);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return err({ code: "UPSTREAM_UNAVAILABLE", status: response.status });
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		// Revue PR #27 : un échec de flux après des en-têtes 200 doit rester
		// une erreur transport typée — jamais s'échapper du failover.
		return err(networkUnavailable);
	}
	if (text.length > MAX_RESPONSE_BYTES) return err(invalidResponse);
	let parsed: z.infer<typeof candlesSchema>;
	try {
		parsed = candlesSchema.parse(JSON.parse(text));
	} catch {
		return err(invalidResponse);
	}
	const candles: Candle[] = [];
	for (const raw of parsed.candles) {
		if (raw.ticker !== request.productId) return err(invalidResponse);
		const start = Date.parse(raw.startedAt);
		if (!Number.isSafeInteger(start) || start < 0) return err(invalidResponse);
		if (start + duration > request.endMs) continue; // bougie en cours : exclue
		const candle = createCandle({
			start,
			open: raw.open,
			high: raw.high,
			low: raw.low,
			close: raw.close,
			volume: raw.baseTokenVolume,
		});
		if (!candle.ok) return err(invalidResponse);
		candles.push(candle.value);
	}
	return ok(Object.freeze(candles.sort((a, b) => a.start - b.start)));
};

export interface DydxBookMid {
	readonly price: number;
	readonly observedAt: number;
}

export const fetchDydxBookMid = async (
	productId: string,
	deps: DydxDeps = {},
): Promise<Result<DydxBookMid, MarketDataError>> => {
	const fetcher = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;
	let response: Response;
	try {
		response = await fetcher(
			`${DYDX_INDEXER_URL}/orderbooks/perpetualMarket/${encodeURIComponent(productId)}`,
			{
				headers: { accept: "application/json", "user-agent": USER_AGENT },
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			},
		);
	} catch {
		return err(networkUnavailable);
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return err({ code: "UPSTREAM_UNAVAILABLE", status: response.status });
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		// Revue PR #27 : un échec de flux après des en-têtes 200 doit rester
		// une erreur transport typée — jamais s'échapper du failover.
		return err(networkUnavailable);
	}
	if (text.length > MAX_RESPONSE_BYTES) return err(invalidResponse);
	let book: z.infer<typeof bookSchema>;
	try {
		book = bookSchema.parse(JSON.parse(text));
	} catch {
		return err(invalidResponse);
	}
	const bid = Math.max(...book.bids.map((b) => b.price));
	const ask = Math.min(...book.asks.map((a) => a.price));
	if (bid > ask) return err(invalidResponse); // carnet croisé
	return ok({ price: bid + (ask - bid) / 2, observedAt: now() });
};
