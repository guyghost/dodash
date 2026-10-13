import { createCandle, type Candle } from "@dodash/domain";
import { z } from "zod";
import { CANDLE_LIMIT, DAY, PRODUCTS, type ProbeRequest } from "./plan.js";

const numeric = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number().finite());
const positive = numeric.pipe(z.number().positive());
const candleSchema = z.object({ start: numeric, open: numeric, high: numeric, low: numeric, close: numeric, volume: numeric });
const candlesSchema = z.object({ candles: z.array(candleSchema).max(5000) });
const hyperSchema = z.array(z.object({ t: numeric, o: numeric, h: numeric, l: numeric, c: numeric, v: numeric, s: z.string(), i: z.literal("1d") })).max(5000);
const dydxSchema = z.object({ candles: z.array(z.object({ startedAt: z.string(), open: numeric, high: numeric, low: numeric, close: numeric, baseTokenVolume: numeric, ticker: z.string(), resolution: z.literal("1DAY") })).max(5000) });
const exchangeSchema = z.array(z.tuple([numeric, numeric, numeric, numeric, numeric, numeric])).max(5000);

export interface CandleSummary {
  readonly kind: "candles";
  readonly market: "spot" | "perp";
  readonly received: number;
  readonly closedCount: number;
  readonly missingStarts: readonly number[];
  readonly duplicateStarts: readonly number[];
  readonly ready: boolean;
  readonly latestStart: number | null;
  readonly latestClose: number | null;
}
export interface QuoteSummary {
  readonly kind: "quote";
  readonly priceKind: "last" | "mid-or-last" | "book-mid";
  readonly prices: Readonly<Record<string, number>>;
  readonly sourceObservedAt: number | null;
}

export const normalizeProbePayload = (request: ProbeRequest, json: unknown, closedAt: number): CandleSummary | QuoteSummary => {
  if (request.kind === "quote") {
    if (request.provider === "hyperliquid") {
      const mids = z.object({ BTC: positive, ETH: positive }).parse(json);
      return { kind: "quote", priceKind: "mid-or-last", prices: { "BTC-USD": mids.BTC, "ETH-USD": mids.ETH }, sourceObservedAt: null };
    }
    if (request.provider === "dydx") {
      const book = z.object({ bids: z.array(z.object({ price: positive })).min(1).max(5000), asks: z.array(z.object({ price: positive })).min(1).max(5000) }).parse(json);
      const bid = Math.max(...book.bids.map((b) => b.price));
      const ask = Math.min(...book.asks.map((a) => a.price));
      if (bid > ask) throw new Error("crossed book");
      return { kind: "quote", priceKind: "book-mid", prices: { [request.product]: bid + (ask - bid) / 2 }, sourceObservedAt: null };
    }
    const parsed = z.object({ price: positive, time: z.string().optional(), product_id: z.string().optional() }).parse(json);
    if (request.provider === "coinbase-advanced" && parsed.product_id !== request.product) throw new Error("wrong product");
    const observed = parsed.time === undefined ? NaN : Date.parse(parsed.time);
    return { kind: "quote", priceKind: "last", prices: { [request.product]: parsed.price }, sourceObservedAt: Number.isSafeInteger(observed) && observed >= 0 ? observed : null };
  }
  let raw: readonly z.infer<typeof candleSchema>[];
  if (request.provider === "hyperliquid") {
    raw = hyperSchema.parse(json).map((c) => {
      if (c.s !== request.product.split("-")[0]) throw new Error("wrong coin");
      return { start: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v };
    });
  } else if (request.provider === "dydx") {
    raw = dydxSchema.parse(json).candles.map((c) => {
      if (c.ticker !== request.product) throw new Error("wrong ticker");
      return { ...c, start: Date.parse(c.startedAt), volume: c.baseTokenVolume };
    });
  } else if (request.provider === "coinbase-exchange") {
    raw = exchangeSchema.parse(json).map(([start, low, high, open, close, volume]) => ({ start: start * 1000, low, high, open, close, volume }));
  } else {
    raw = candlesSchema.parse(json).candles.map((c) => ({ ...c, start: c.start * 1000 }));
  }
  const byStart = new Map<number, Candle>();
  const duplicates: number[] = [];
  const start = closedAt - CANDLE_LIMIT * DAY;
  for (const c of raw) {
    if (!Number.isSafeInteger(c.start) || c.start < 0 || c.start % DAY !== 0) throw new Error("invalid candle grid");
    const validated = createCandle(c);
    if (!validated.ok) throw new Error("invalid OHLCV");
    if (c.start < start || c.start + DAY > closedAt) continue;
    if (byStart.has(c.start)) duplicates.push(c.start);
    byStart.set(c.start, validated.value);
  }
  const missingStarts = Array.from({ length: CANDLE_LIMIT }, (_, i) => start + i * DAY).filter((t) => !byStart.has(t));
  const latest = byStart.get(closedAt - DAY);
  return { kind: "candles", market: request.provider.startsWith("coinbase") ? "spot" : "perp",
    received: raw.length, closedCount: byStart.size, missingStarts, duplicateStarts: duplicates,
    ready: missingStarts.length === 0 && duplicates.length === 0, latestStart: latest?.start ?? null, latestClose: latest?.close ?? null };
};

export const compareLatestCloses = (rows: readonly { request: ProbeRequest; data?: CandleSummary | QuoteSummary }[]) =>
  PRODUCTS.map((product) => {
    const candles = rows.filter((r) => r.request.product === product && r.data?.kind === "candles");
    const reference = candles.find((r) => r.request.provider === "coinbase-advanced")?.data as CandleSummary | undefined;
    return { product, referenceStart: reference?.latestStart ?? null,
      differences: candles.map(({ request, data }) => {
        const candle = data as CandleSummary;
        const bps = reference !== undefined && candle.latestStart !== null && candle.latestStart === reference.latestStart && reference.latestClose !== null && candle.latestClose !== null
          ? (candle.latestClose / reference.latestClose - 1) * 10_000 : NaN;
        return { provider: request.provider, bps: Number.isFinite(bps) ? bps : null };
      }) };
  });
