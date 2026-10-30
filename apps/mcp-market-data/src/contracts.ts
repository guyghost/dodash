import { TIMEFRAMES } from "@dodash/domain";
import { z } from "zod";

export const candleRequestSchema = z.object({
	productId: z.string().trim().min(1).max(31),
	timeframe: z.enum(TIMEFRAMES),
	limit: z.number().int().min(1).max(350).default(200),
	end: z.number().int().nonnegative().optional(),
	/** Override opérateur (models/market-source-failover.md §5) ; défaut : ordre figé. */
	sources: z
		.array(z.enum(["COINBASE", "HYPERLIQUID", "DYDX"]))
		.min(1)
		.max(3)
		.optional(),
});

export type CandleRequest = z.infer<typeof candleRequestSchema>;

export const tickerRequestSchema = z.object({
	productId: z.string().trim().min(1).max(31),
	/** Override opérateur (models/market-source-failover.md §5) ; défaut : ordre figé. */
	sources: z
		.array(z.enum(["COINBASE", "HYPERLIQUID", "DYDX"]))
		.min(1)
		.max(3)
		.optional(),
});

export type TickerRequest = z.infer<typeof tickerRequestSchema>;
