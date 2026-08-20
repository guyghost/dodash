import { generateKeyPairSync } from "node:crypto";
import { createProductId, type OrderIntent } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import {
  COINBASE_CREATE_ORDER_PATH,
  applyCoinbaseFill,
  createCoinbaseAuthorization,
  getCoinbaseOrder,
  resolveCoinbaseSettings,
  submitCoinbaseOrder,
  type CoinbaseExecutionSettings,
} from "../src/coinbase-execution.js";

const NOW = 1_700_000_000_000;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const settings: CoinbaseExecutionSettings = Object.freeze({
  apiBaseUrl: "https://api.coinbase.com",
  apiKeyId: "organizations/org/apiKeys/key",
  privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
});

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid test product");
const intent: OrderIntent = Object.freeze({
  clientOrderId: "11111111-2222-5333-a444-555555555555",
  decisionId: "decision-1",
  strategyIds: Object.freeze(["rsi-reversion"]),
  productId: product.value,
  side: "BUY",
  type: "MARKET",
  quantity: 0.00000001,
  limitPrice: null,
});

const authorizationFor = (method: "GET" | "POST", path: string) => {
  const authorization = createCoinbaseAuthorization(settings, method, path, {
    now: () => NOW,
    nonce: () => "0123456789abcdef0123456789abcdef",
  });
  if (!authorization.ok) throw new Error("test authorization failed");
  return authorization.value;
};

describe("Coinbase execution adapter", () => {
  it("requires explicit live enablement and server-side credentials", () => {
    expect(resolveCoinbaseSettings({})).toEqual({
      ok: false,
      error: { code: "LIVE_EXECUTION_UNAVAILABLE" },
    });
    const resolved = resolveCoinbaseSettings({
      LIVE_TRADING_ENABLED: "true",
      COINBASE_API_KEY_ID: settings.apiKeyId,
      COINBASE_API_PRIVATE_KEY: settings.privateKeyPem,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.apiBaseUrl).toBe("https://api.coinbase.com");
  });

  it("submits a base-sized market IOC and requires reconciliation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json({
        success: true,
        success_response: {
          order_id: "exchange-order-1",
          product_id: "BTC-USD",
          side: "BUY",
          client_order_id: intent.clientOrderId,
        },
      }),
    );
    const result = await submitCoinbaseOrder(
      settings,
      intent,
      authorizationFor("POST", COINBASE_CREATE_ORDER_PATH),
      { fetch: fetchMock, now: () => NOW },
    );

    expect(result).toMatchObject({
      status: "UNKNOWN",
      exchangeOrderId: "exchange-order-1",
      error: { code: "ORDER_OUTCOME_UNKNOWN", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.coinbase.com/api/v3/brokerage/orders");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      client_order_id: intent.clientOrderId,
      product_id: "BTC-USD",
      side: "BUY",
      order_configuration: { market_market_ioc: { base_size: "0.00000001" } },
    });
  });

  it("rounds a confirmed live product quantity down to its Coinbase base increment", async () => {
    const grt = createProductId("GRT-USD");
    if (!grt.ok) throw new Error("invalid GRT fixture");
    const grtIntent = Object.freeze({
      ...intent,
      productId: grt.value,
      quantity: 42.1234,
    });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        success: true,
        success_response: {
          order_id: "exchange-order-grt",
          product_id: "GRT-USD",
          side: "BUY",
          client_order_id: grtIntent.clientOrderId,
        },
      }),
    );

    await submitCoinbaseOrder(
      settings,
      grtIntent,
      authorizationFor("POST", COINBASE_CREATE_ORDER_PATH),
      { fetch: fetchMock, now: () => NOW },
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      order_configuration: { market_market_ioc: { base_size: "42.12" } },
    });
  });

  it("treats network and 5xx outcomes as unknown", async () => {
    const authorization = authorizationFor("POST", COINBASE_CREATE_ORDER_PATH);
    const network = await submitCoinbaseOrder(settings, intent, authorization, {
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error("socket closed");
      }),
      now: () => NOW,
    });
    expect(network).toMatchObject({
      status: "UNKNOWN",
      error: { code: "ORDER_OUTCOME_UNKNOWN" },
    });

    const server = await submitCoinbaseOrder(settings, intent, authorization, {
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
      now: () => NOW,
    });
    expect(server.status).toBe("UNKNOWN");
  });

  it("maps an explicit Coinbase rejection to a terminal rejection", async () => {
    const result = await submitCoinbaseOrder(
      settings,
      intent,
      authorizationFor("POST", COINBASE_CREATE_ORDER_PATH),
      {
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({
            success: false,
            error_response: { error: "INVALID_ORDER", message: "invalid" },
          }),
        ),
        now: () => NOW,
      },
    );
    expect(result).toEqual({
      status: "REJECTED",
      error: { phase: "execution", code: "ORDER_REJECTED", retryable: false },
    });
  });

  it("confirms only a terminal order and applies the reported fill", async () => {
    const exchangeOrderId = "exchange-order-1";
    const path = `${COINBASE_CREATE_ORDER_PATH}/historical/${exchangeOrderId}`;
    const result = await getCoinbaseOrder(
      settings,
      intent,
      exchangeOrderId,
      authorizationFor("GET", path),
      { cash: 1_000, positionQuantity: 0, averagePrice: 0 },
      {
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({
            order: {
              order_id: exchangeOrderId,
              product_id: "BTC-USD",
              client_order_id: intent.clientOrderId,
              side: "BUY",
              status: "FILLED",
              average_filled_price: "50000",
              total_fees: "0.03",
              filled_size: "0.00000001",
              last_fill_time: "2023-11-14T22:13:20.000Z",
            },
          }),
        ),
        now: () => NOW,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== "CONFIRMED") return;
    expect(result.value.fill).toMatchObject({
      exchangeOrderId,
      price: 50_000,
      quantity: 0.00000001,
      fee: 0.03,
      executedAt: NOW,
    });
    expect(result.value.portfolio).toEqual({
      cash: 999.9695,
      positionQuantity: 0.00000001,
      averagePrice: 50_000,
    });
  });

  it("keeps an intermediate order in retryable reconciliation", async () => {
    const exchangeOrderId = "exchange-order-2";
    const path = `${COINBASE_CREATE_ORDER_PATH}/historical/${exchangeOrderId}`;
    const result = await getCoinbaseOrder(
      settings,
      intent,
      exchangeOrderId,
      authorizationFor("GET", path),
      { cash: 1_000, positionQuantity: 0, averagePrice: 0 },
      {
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({
            order: {
              order_id: exchangeOrderId,
              product_id: "BTC-USD",
              client_order_id: intent.clientOrderId,
              side: "BUY",
              status: "PENDING",
              average_filled_price: "0",
              total_fees: "0",
              filled_size: "0",
            },
          }),
        ),
        now: () => NOW,
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "reconciliation",
        code: "RECONCILIATION_FAILURE",
        retryable: true,
      },
    });
  });

  it("applies an actual sell fill without paper slippage", () => {
    const sellIntent = { ...intent, side: "SELL" as const, quantity: 0.25 };
    const result = applyCoinbaseFill(
      { cash: 10, positionQuantity: 0.5, averagePrice: 80 },
      sellIntent,
      {
        exchangeOrderId: "sell-order",
        price: 100,
        quantity: 0.25,
        fee: 1,
        executedAt: NOW,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        portfolio: { cash: 34, positionQuantity: 0.25, averagePrice: 80 },
      },
    });
  });
});
