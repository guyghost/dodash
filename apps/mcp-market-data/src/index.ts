import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { CoinbaseMarketData, type MarketDataError } from "./coinbase.js";
import { candleRequestSchema, tickerRequestSchema } from "./contracts.js";

const sourcesOverrideSchema = z.object({
	sources: z
		.array(z.enum(["COINBASE", "HYPERLIQUID", "DYDX"]))
		.min(1)
		.max(3)
		.optional(),
});

import { TIMEFRAME_MILLISECONDS } from "@dodash/domain";
import {
	MARKET_SOURCE_ORDER,
	type MarketSourceFailure,
	type MarketSourceId,
	resolveMarketSource,
} from "@dodash/models";
import {
	serveBackupCandles,
	serveBackupTicker,
	writeBasisReference,
} from "./failover.js";
import { createMarketMcpServer } from "./server.js";

const MAX_INTERNAL_REQUEST_BYTES = 16_384;

interface MarketDataEnv extends Env {
	readonly INTERNAL_SERVICE_TOKEN: string;
}

const json = (
	body: unknown,
	status = 200,
	extraHeaders: Readonly<Record<string, string>> = {},
): Response =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store", ...extraHeaders },
	});

/** Réponse d'erreur interne ; propage `Retry-After` amont sur 429 (effects.md). */
const marketErrorResponse = (error: MarketDataError): Response =>
	json(
		{ error },
		marketErrorStatus(error),
		error.code === "RATE_LIMITED" && error.retryAfterSeconds !== undefined
			? { "retry-after": String(error.retryAfterSeconds) }
			: {},
	);

const constantTimeEqual = (left: string, right: string): boolean => {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
};

const createMarket = (env: MarketDataEnv): CoinbaseMarketData =>
	new CoinbaseMarketData({
		baseUrl: env.COINBASE_API_BASE_URL,
		cache: env.MARKET_CACHE,
		cacheTtlSeconds: Number(env.MARKET_CACHE_TTL_SECONDS),
	});

const isAuthorizedInternalRequest = (
	request: Request,
	env: MarketDataEnv,
): boolean => {
	const token = request.headers
		.get("authorization")
		?.replace(/^Bearer\s+/i, "");
	const expectedToken = env.INTERNAL_SERVICE_TOKEN;
	return (
		token !== undefined &&
		typeof expectedToken === "string" &&
		expectedToken.length >= 32 &&
		constantTimeEqual(token, expectedToken)
	);
};

const marketErrorStatus = (error: MarketDataError): number => {
	switch (error.code) {
		case "INVALID_REQUEST":
			return 400;
		case "RATE_LIMITED":
			return 429;
		case "NETWORK_UNAVAILABLE":
			return 503;
		case "INVALID_RESPONSE":
		case "UPSTREAM_UNAVAILABLE":
			return 502;
	}
};

const handleInternalRequest = async (
	request: Request,
	env: MarketDataEnv,
	kind: "candles" | "ticker",
): Promise<Response> => {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { allow: "POST" },
		});
	}
	if (!isAuthorizedInternalRequest(request, env)) {
		return json({ error: { code: "UNAUTHORIZED" } }, 401);
	}

	let body: unknown;
	try {
		body = await readBoundedJson(request, MAX_INTERNAL_REQUEST_BYTES);
	} catch {
		return json({ error: { code: "INVALID_REQUEST" } }, 400);
	}

	const market = createMarket(env);
	const attempts: { source: MarketSourceId; failure: MarketSourceFailure }[] =
		[];
	const failures: Partial<Record<MarketSourceId, MarketSourceFailure>> = {};
	// L'erreur Coinbase complète est conservée : l'épuisement total restitue
	// le contrat d'erreur existant (Retry-After compris), sans nouvelle forme.
	let lastCoinbaseError: MarketDataError | null = null;
	// Ordre figé (models/market-source-failover.md §2) ; override opérateur.
	const override = sourcesOverrideSchema.safeParse(body);
	const sources: readonly MarketSourceId[] =
		override.success && override.data.sources !== undefined
			? override.data.sources
			: MARKET_SOURCE_ORDER;

	if (kind === "candles") {
		const parsed = candleRequestSchema.safeParse(body);
		if (!parsed.success)
			return json({ error: { code: "INVALID_REQUEST" } }, 400);
		for (;;) {
			const resolution = resolveMarketSource(sources, failures);
			if ("exhausted" in resolution) {
				if (lastCoinbaseError !== null) {
					return marketErrorResponse(lastCoinbaseError);
				}
				return json({ error: { code: "RATE_LIMITED" }, attempts }, 429);
			}
			const { source } = resolution;
			if (source === "COINBASE") {
				const result = await market.getCandles(parsed.data);
				if (result.ok) {
					// Référence de basis : write-through de la dernière close réussie.
					await writeBasisReference(
						env.MARKET_CACHE,
						parsed.data.productId,
						parsed.data.timeframe,
						result.value.candles,
					);
					return json({ ...result.value, source: "coinbase", attempts });
				}
				lastCoinbaseError = result.error;
				const failure = mapFailure(result.error.code);
				failures.COINBASE = failure;
				attempts.push({ source, failure });
				continue;
			}
			const endMs =
				parsed.data.end !== undefined
					? parsed.data.end * 1_000 +
						TIMEFRAME_MILLISECONDS[parsed.data.timeframe]
					: Date.now();
			const backup = await serveBackupCandles(
				source,
				{
					productId: parsed.data.productId,
					timeframe: parsed.data.timeframe,
					limit: parsed.data.limit,
					endMs,
				},
				env.MARKET_CACHE,
			);
			if (backup.ok && backup.candles !== undefined) {
				return json({
					productId: parsed.data.productId,
					timeframe: parsed.data.timeframe,
					candles: backup.candles,
					source: source === "HYPERLIQUID" ? "hyperliquid" : "dydx",
					cached: false,
					attempts,
				});
			}
			const failure = backup.failure ?? "NETWORK_UNAVAILABLE";
			failures[source] = failure;
			attempts.push({ source, failure });
		}
	}

	const parsed = tickerRequestSchema.safeParse(body);
	if (!parsed.success) return json({ error: { code: "INVALID_REQUEST" } }, 400);
	for (;;) {
		const resolution = resolveMarketSource(sources, failures);
		if ("exhausted" in resolution) {
			if (lastCoinbaseError !== null) {
				return marketErrorResponse(lastCoinbaseError);
			}
			return json({ error: { code: "RATE_LIMITED" }, attempts }, 429);
		}
		const { source } = resolution;
		if (source === "COINBASE") {
			const result = await market.getTicker(parsed.data);
			if (result.ok)
				return json({ ...result.value, source: "coinbase", attempts });
			lastCoinbaseError = result.error;
			const failure = mapFailure(result.error.code);
			failures.COINBASE = failure;
			attempts.push({ source, failure });
			continue;
		}
		const backup = await serveBackupTicker(source, parsed.data.productId);
		if (
			backup.ok &&
			backup.price !== undefined &&
			backup.observedAt !== undefined
		) {
			return json({
				productId: parsed.data.productId,
				price: backup.price,
				observedAt: backup.observedAt,
				source: source === "HYPERLIQUID" ? "hyperliquid" : "dydx",
				cached: false,
				attempts,
			});
		}
		const failure = backup.failure ?? "NETWORK_UNAVAILABLE";
		failures[source] = failure;
		attempts.push({ source, failure });
	}
};

const mapFailure = (code: string): MarketSourceFailure => {
	switch (code) {
		case "RATE_LIMITED":
			return "RATE_LIMITED";
		case "NETWORK_UNAVAILABLE":
			return "NETWORK_UNAVAILABLE";
		case "INVALID_RESPONSE":
		case "INVALID_REQUEST":
			return "INVALID_RESPONSE";
		default:
			return "NETWORK_UNAVAILABLE";
	}
};

export const handleWorkerRequest = async (
	request: Request,
	env: MarketDataEnv,
	ctx: ExecutionContext,
): Promise<Response> => {
	const { pathname } = new URL(request.url);

	if (pathname === "/health") {
		return json({ status: "ok", service: "dodash-mcp-market-data" });
	}
	if (pathname === "/internal/candles") {
		return handleInternalRequest(request, env, "candles");
	}
	if (pathname === "/internal/ticker") {
		return handleInternalRequest(request, env, "ticker");
	}
	if (pathname === "/mcp") {
		const handler = createMcpHandler(
			() => createMarketMcpServer(createMarket(env)),
			{
				route: "/mcp",
				corsOptions: false,
				onerror: (error) => {
					console.error(
						JSON.stringify({
							event: "mcp_request_failed",
							errorType: error.name,
						}),
					);
				},
			},
		);
		return handler(request, env, ctx);
	}

	return new Response("Not Found", { status: 404 });
};

export default {
	fetch: handleWorkerRequest,
} satisfies ExportedHandler<MarketDataEnv>;
