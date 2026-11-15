/**
 * Hyperliquid perp transport (models/market-source-failover.md §3,
 * sémantiques du comparateur market-source-probe.md) : bougies via
 * `candleSnapshot`, prix via `allMids` (mid, ou dernier trade si carnet
 * vide). Public uniquement, User-Agent transparent, redirects refusés,
 * réponse ≤ 2 MiB, timeout 10 s. BTC/ETH au plan initial.
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

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "dodash-market-data/0.1 (diagnostic; contact: guyghost)";

const numeric = z
	.union([z.number(), z.string().trim().min(1)])
	.transform(Number)
	.pipe(z.number().finite());

const candleSnapshotSchema = z
	.array(
		z.object({
			t: numeric,
			o: numeric,
			h: numeric,
			l: numeric,
			c: numeric,
			v: numeric,
			s: z.string(),
		}),
	)
	.max(5000);

const allMidsSchema = z.record(z.string(), numeric);

/** Granularités acceptées par candleSnapshot, mappées sur la grille du dépôt. */
const INTERVAL_BY_TIMEFRAME: Readonly<Record<Timeframe, string>> =
	Object.freeze({
		ONE_MINUTE: "1m",
		FIVE_MINUTE: "5m",
		FIFTEEN_MINUTE: "15m",
		ONE_HOUR: "1h",
		SIX_HOUR: "6h",
		ONE_DAY: "1d",
	});

const coinOf = (productId: string): string | null => {
	const coin = productId.split("-")[0];
	return coin === undefined || coin.length === 0 ? null : coin;
};

export interface BackupCandleRequest {
	readonly productId: string;
	readonly timeframe: Timeframe;
	readonly limit: number;
	/** Instant de fin de fenêtre (ms) : seules les bougies closes ≤ end sont retenues. */
	readonly endMs: number;
}

export interface HyperliquidDeps {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

const invalidResponse: MarketDataError = { code: "INVALID_RESPONSE" };
const networkUnavailable: MarketDataError = { code: "NETWORK_UNAVAILABLE" };

export const fetchHyperliquidCandles = async (
	request: BackupCandleRequest,
	deps: HyperliquidDeps = {},
): Promise<Result<readonly Candle[], MarketDataError>> => {
	const coin = coinOf(request.productId);
	if (coin === null) return err({ code: "INVALID_REQUEST" });
	const duration = TIMEFRAME_MILLISECONDS[request.timeframe];
	const fetcher = deps.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetcher(HYPERLIQUID_INFO_URL, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": USER_AGENT },
			body: JSON.stringify({
				type: "candleSnapshot",
				req: {
					coin,
					interval: INTERVAL_BY_TIMEFRAME[request.timeframe],
					startTime: request.endMs - request.limit * duration,
					endTime: request.endMs - 1,
				},
			}),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
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
	if (text.length > MAX_RESPONSE_BYTES) {
		return err(invalidResponse);
	}
	let parsed: z.infer<typeof candleSnapshotSchema>;
	try {
		parsed = candleSnapshotSchema.parse(JSON.parse(text));
	} catch {
		return err(invalidResponse);
	}
	const candles: Candle[] = [];
	for (const raw of parsed) {
		if (raw.s !== coin) return err(invalidResponse);
		if (raw.t + duration > request.endMs) continue; // bougie en cours : exclue
		const candle = createCandle({
			start: raw.t,
			open: raw.o,
			high: raw.h,
			low: raw.l,
			close: raw.c,
			volume: raw.v,
		});
		if (!candle.ok) return err(invalidResponse);
		candles.push(candle.value);
	}
	return ok(Object.freeze(candles.sort((a, b) => a.start - b.start)));
};

export interface HyperliquidMid {
	readonly price: number;
	/** Mid sans horodatage amont : l'instant du fetch est l'observation honnête. */
	readonly observedAt: number;
}

export const fetchHyperliquidMid = async (
	productId: string,
	deps: HyperliquidDeps = {},
): Promise<Result<HyperliquidMid, MarketDataError>> => {
	const coin = coinOf(productId);
	if (coin === null) return err({ code: "INVALID_REQUEST" });
	const fetcher = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;
	let response: Response;
	try {
		response = await fetcher(HYPERLIQUID_INFO_URL, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": USER_AGENT },
			body: JSON.stringify({ type: "allMids" }),
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
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
	let mids: Record<string, number>;
	try {
		mids = allMidsSchema.parse(JSON.parse(text));
	} catch {
		return err(invalidResponse);
	}
	const price = mids[coin];
	if (price === undefined || price <= 0) return err(invalidResponse);
	return ok({ price, observedAt: now() });
};
