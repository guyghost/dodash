import { describe, expect, it } from "vitest";

import {
  MAX_TICKER_DIVERGENCE_BPS,
  createCandle,
  createClientOrderId,
  createFill,
  createOrderIntent,
  createProductId,
  createSignal,
  validateCandleSeries,
  validateMarketDataIntegrity,
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

describe("validateMarketDataIntegrity — models/market-data-integrity.md", () => {
  const candle = (start: number, close = 100) => ({
    start,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  });
  const intervalMs = 60_000;
  const conformingSeries = [candle(0), candle(60_000), candle(120_000)];

  it("accepte une série conforme (INV-I6)", () => {
    const result = validateMarketDataIntegrity(
      conformingSeries,
      intervalMs,
      { price: 100.5 },
    );
    expect(result.ok).toBe(true);
  });

  it("rejette une bougie manquante au milieu avec son index", () => {
    const result = validateMarketDataIntegrity(
      [candle(0), candle(60_000), candle(180_000)],
      intervalMs,
      null,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "CANDLE_GAP", index: 2, expectedIntervalMs: intervalMs },
    });
  });

  it("rejette les timestamps désordonnés et les doublons via les codes existants", () => {
    expect(
      validateMarketDataIntegrity(
        [candle(60_000), candle(0)],
        intervalMs,
        null,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_SERIES",
        cause: { code: "UNSORTED_CANDLE_SERIES", index: 1 },
      },
    });
    expect(
      validateMarketDataIntegrity(
        [candle(0), candle(0)],
        intervalMs,
        null,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_SERIES",
        cause: { code: "DUPLICATE_CANDLE", index: 1 },
      },
    });
    expect(
      validateMarketDataIntegrity([], intervalMs, null),
    ).toEqual({
      ok: false,
      error: {
        code: "INVALID_SERIES",
        cause: { code: "EMPTY_CANDLE_SERIES" },
      },
    });
  });

  it("rejette un intervalle déclaré invalide", () => {
    expect(
      validateMarketDataIntegrity(conformingSeries, 0, null),
    ).toEqual({ ok: false, error: { code: "INVALID_INTERVAL" } });
    expect(
      validateMarketDataIntegrity(conformingSeries, Number.NaN, null),
    ).toEqual({ ok: false, error: { code: "INVALID_INTERVAL" } });
  });

  it("applique la tolérance ticker figée à la borne incluse (INV-I2)", () => {
    expect(MAX_TICKER_DIVERGENCE_BPS).toBe(100);
    // 101 vs close 100 = exactement 100 bps → conforme.
    expect(
      validateMarketDataIntegrity(conformingSeries, intervalMs, { price: 101 })
        .ok,
    ).toBe(true);
    // 101.1 vs close 100 = 110 bps → rejet fermé avec la cause chiffrée.
    expect(
      validateMarketDataIntegrity(conformingSeries, intervalMs, {
        price: 101.1,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "TICKER_INCOHERENT",
        divergenceBps: 109.99999999999943,
        maxDivergenceBps: 100,
      },
    });
  });

  it("rejette un prix de ticker non fini ou non positif", () => {
    expect(
      validateMarketDataIntegrity(conformingSeries, intervalMs, {
        price: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ ok: false, error: { code: "TICKER_INVALID_PRICE" } });
    expect(
      validateMarketDataIntegrity(conformingSeries, intervalMs, { price: 0 }),
    ).toEqual({ ok: false, error: { code: "TICKER_INVALID_PRICE" } });
  });

  it("n'applique pas le contrôle ticker au rejeu (ticker null, INV-I7)", () => {
    const result = validateMarketDataIntegrity(
      conformingSeries,
      intervalMs,
      null,
    );
    expect(result.ok).toBe(true);
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

