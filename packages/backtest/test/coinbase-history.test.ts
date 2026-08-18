import { describe, expect, it } from "vitest";

import { createProductId } from "@dodash/domain";

import * as backtest from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1_000;
const START_AT = Date.UTC(2025, 0, 1);

const candle = (startSeconds: number) => ({
  start: String(startSeconds),
  low: "99",
  high: "102",
  open: "100",
  close: "101",
  volume: "12.5",
});

const coinbasePage = (url: URL): Response => {
  const start = Number(url.searchParams.get("start")) + DAY_SECONDS;
  const end = Number(url.searchParams.get("end"));
  const candles = [];
  for (let at = start; at <= end; at += DAY_SECONDS) candles.push(candle(at));
  return Response.json({ candles: candles.reverse() });
};

describe("Coinbase historical dataset", () => {
  it("expose un chargeur historique par la frontière publique", () => {
    expect(
      typeof (backtest as Record<string, unknown>).loadCoinbaseHistoricalDataset,
    ).toBe("function");
  });

  it("charge plus de 350 bougies par pages et fige leur provenance", async () => {
    const urls: URL[] = [];
    const result = await backtest.loadCoinbaseHistoricalDataset({
      productId: product.value,
      timeframe: "ONE_DAY",
      startAt: START_AT,
      endAt: START_AT + 351 * DAY_MS,
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        return coinbasePage(url);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.get("start")).toBe(
      String((START_AT / 1_000) - DAY_SECONDS),
    );
    expect(urls[0]?.searchParams.get("limit")).toBe("350");
    expect(urls[1]?.searchParams.get("limit")).toBe("1");
    expect(result.value.candles).toHaveLength(351);
    expect(result.value.candles[0]?.start).toBe(START_AT);
    expect(result.value.candles.at(-1)?.start).toBe(START_AT + 350 * DAY_MS);
    expect(result.value.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value.datasetId).toContain(result.value.sha256);
    expect(result.value.endpoint).toBe(
      "https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles",
    );
  });

  it("rejette une série historique avec un trou", async () => {
    const result = await backtest.loadCoinbaseHistoricalDataset({
      productId: product.value,
      timeframe: "ONE_DAY",
      startAt: START_AT,
      endAt: START_AT + 3 * DAY_MS,
      fetch: async () =>
        Response.json({
          candles: [
            candle((START_AT / 1_000) + 2 * DAY_SECONDS),
            candle(START_AT / 1_000),
          ],
        }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INCOMPLETE_HISTORICAL_DATA" },
    });
  });

  it("rejette les timestamps dupliqués entre pages", async () => {
    const duplicate = candle(START_AT / 1_000);
    const result = await backtest.loadCoinbaseHistoricalDataset({
      productId: product.value,
      timeframe: "ONE_DAY",
      startAt: START_AT,
      endAt: START_AT + 2 * DAY_MS,
      fetch: async () => Response.json({ candles: [duplicate, duplicate] }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INCOMPLETE_HISTORICAL_DATA" },
    });
  });

  it("rejette une fenêtre non alignée sur la granularité", async () => {
    const result = await backtest.loadCoinbaseHistoricalDataset({
      productId: product.value,
      timeframe: "ONE_DAY",
      startAt: START_AT + 1,
      endAt: START_AT + DAY_MS,
      fetch: async () => Response.json({ candles: [] }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_HISTORICAL_REQUEST" },
    });
  });
});
