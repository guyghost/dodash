import { TIMEFRAMES } from "@dodash/domain";
import { z } from "zod";

export const candleRequestSchema = z.object({
  productId: z.string().trim().min(1).max(31),
  timeframe: z.enum(TIMEFRAMES),
  limit: z.number().int().min(1).max(350).default(200),
  end: z.number().int().nonnegative().optional(),
});

export type CandleRequest = z.infer<typeof candleRequestSchema>;

export const tickerRequestSchema = z.object({
  productId: z.string().trim().min(1).max(31),
});

export type TickerRequest = z.infer<typeof tickerRequestSchema>;
