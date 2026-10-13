import type { MarketProbeProvider } from "@dodash/models";

export const DAY = 86_400_000;
export const CANDLE_LIMIT = 240;
export const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
export type Product = typeof PRODUCTS[number];
export interface ProbeRequest {
  readonly provider: MarketProbeProvider;
  readonly kind: "candles" | "quote";
  readonly product: Product | "ALL";
  readonly url: string;
  readonly body?: unknown;
}

export const planProbeRequests = (now: number): readonly ProbeRequest[] => {
  const closedAt = Math.floor(now / DAY) * DAY;
  const start = closedAt - CANDLE_LIMIT * DAY;
  const lastStart = closedAt - DAY;
  const requests: ProbeRequest[] = [];
  for (const product of PRODUCTS) {
    const advanced = new URLSearchParams({ start: String(start / 1000), end: String(lastStart / 1000), granularity: "ONE_DAY", limit: String(CANDLE_LIMIT) });
    const exchange = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(lastStart).toISOString(), granularity: "86400" });
    const dydx = new URLSearchParams({ resolution: "1DAY", fromISO: new Date(start).toISOString(), toISO: new Date(closedAt).toISOString(), limit: String(CANDLE_LIMIT) });
    requests.push(
      { provider: "coinbase-advanced", kind: "candles", product, url: `https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?${advanced}` },
      { provider: "coinbase-exchange", kind: "candles", product, url: `https://api.exchange.coinbase.com/products/${product}/candles?${exchange}` },
      { provider: "hyperliquid", kind: "candles", product, url: "https://api.hyperliquid.xyz/info", body: { type: "candleSnapshot", req: { coin: product.split("-")[0], interval: "1d", startTime: start, endTime: closedAt - 1 } } },
      { provider: "dydx", kind: "candles", product, url: `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${product}?${dydx}` },
      { provider: "coinbase-advanced", kind: "quote", product, url: `https://api.coinbase.com/api/v3/brokerage/market/products/${product}` },
      { provider: "coinbase-exchange", kind: "quote", product, url: `https://api.exchange.coinbase.com/products/${product}/ticker` },
      { provider: "dydx", kind: "quote", product, url: `https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${product}` },
    );
  }
  requests.push({ provider: "hyperliquid", kind: "quote", product: "ALL", url: "https://api.hyperliquid.xyz/info", body: { type: "allMids" } });
  return requests;
};
