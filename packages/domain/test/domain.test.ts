import { describe, expect, it } from "vitest";

import {
  createCandle,
  createClientOrderId,
  createFill,
  createOrderIntent,
  createProductId,
  createSignal,
  validateCandleSeries,
} from "../src/index.js";

const product = () => {
  const result = createProductId("btc-usd");
  if (!result.ok) throw new Error("fixture product should be valid");
  return result.value;
};

describe("market domain", () => {
  it("normalise une paire valide", () => {
    expect(createProductId(" btc-usd ")).toEqual({ ok: true, value: "BTC-USD" });
    expect(createProductId("BTC-BTC")).toEqual({
      ok: false,
      error: { code: "INVALID_PRODUCT_ID" },
    });
  });

  it("refuse une chandelle incohérente", () => {
    const result = createCandle({
      start: 1_000,
      open: 100,
      high: 99,
      low: 90,
      close: 95,
      volume: 10,
    });
    expect(result).toEqual({ ok: false, error: { code: "INVALID_OHLC_RANGE" } });
  });

  it("refuse les doublons et séries non triées", () => {
    const candle = {
      start: 1_000,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 10,
    };
    expect(validateCandleSeries([candle, candle])).toEqual({
      ok: false,
      error: { code: "DUPLICATE_CANDLE", index: 1 },
    });
    expect(
      validateCandleSeries([{ ...candle, start: 2_000 }, candle]),
    ).toEqual({
      ok: false,
      error: { code: "UNSORTED_CANDLE_SERIES", index: 1 },
    });
  });
});

describe("trading domain", () => {
  it("interdit une taille sur HOLD", () => {
    const result = createSignal({
      strategyId: "rsi-reversion",
      productId: product(),
      side: "HOLD",
      confidence: 0.5,
      suggestedSize: 1,
      reasonCode: "RSI_NEUTRAL",
    });
    expect(result).toEqual({ ok: false, error: { code: "HOLD_WITH_SIZE" } });
  });

  it("produit un clientOrderId déterministe au format UUID", () => {
    const first = createClientOrderId("agent", "cycle", "decision", 0);
    const second = createClientOrderId("agent", "cycle", "decision", 0);
    const other = createClientOrderId("agent", "cycle", "decision", 1);

    expect(first).toEqual(second);
    expect(first.ok && first.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(other).not.toEqual(first);
  });

  it("valide la cohérence MARKET/LIMIT", () => {
    const base = {
      clientOrderId: "order-1",
      decisionId: "decision-1",
      strategyIds: ["rsi-reversion"],
      productId: product(),
      side: "BUY" as const,
      quantity: 0.01,
    };
    expect(
      createOrderIntent({ ...base, type: "MARKET", limitPrice: 42_000 }),
    ).toEqual({ ok: false, error: { code: "MARKET_WITH_LIMIT_PRICE" } });
    expect(
      createOrderIntent({ ...base, type: "LIMIT", limitPrice: null }),
    ).toEqual({ ok: false, error: { code: "INVALID_LIMIT_PRICE" } });
  });

  it("refuse un fill de quantité nulle", () => {
    expect(
      createFill({
        fillId: "fill-1",
        clientOrderId: "client-1",
        exchangeOrderId: "exchange-1",
        price: 42_000,
        quantity: 0,
        fee: 0,
        executedAt: 1_000,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_FILL" } });
  });
});

