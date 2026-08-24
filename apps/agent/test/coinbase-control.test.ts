import { generateKeyPairSync } from "node:crypto";
import { createProductId, type OrderIntent } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import {
  deriveCoinbaseControlClientOrderId,
  executeCoinbaseKill,
  executeCoinbaseProtectedSell,
} from "../src/coinbase-control.js";
import type { CoinbaseExecutionSettings } from "../src/coinbase-execution.js";

const NOW = 1_700_000_000_000;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const settings: CoinbaseExecutionSettings = Object.freeze({
  apiBaseUrl: "https://api.coinbase.com",
  apiKeyId: "organizations/org/apiKeys/key",
  privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
  portfolioId: "portfolio-1",
});
const product = createProductId("GRT-USD");
if (!product.ok) throw new Error("invalid product fixture");
const sellIntent: OrderIntent = Object.freeze({
  clientOrderId: "11111111-2222-5333-a444-555555555555",
  decisionId: "decision-sell-1",
  strategyIds: Object.freeze(["rsi-reversion"]),
  productId: product.value,
  side: "SELL",
  type: "MARKET",
  quantity: 10,
  limitPrice: null,
});

const openOrders = (orderIds: readonly string[]) =>
  Response.json({
    orders: orderIds.map((order_id) => ({
      order_id,
      product_id: "GRT-USD",
      status: "OPEN",
    })),
    has_next: false,
    cursor: "",
  });

const portfolio = (quantity: number, available = quantity) =>
  Response.json({
    breakdown: {
      portfolio: {
        uuid: settings.portfolioId,
        name: "Live",
        type: "DEFAULT",
        deleted: false,
      },
      portfolio_balances: {
        total_balance: { value: String(1_000 + quantity * 10), currency: "USD" },
      },
      spot_positions: [
        {
          asset: "USD",
          account_uuid: "usd-account",
          total_balance_fiat: 1_000,
          total_balance_crypto: 1_000,
          available_to_trade_fiat: 1_000,
          available_to_trade_crypto: 1_000,
          average_entry_price: { value: "1", currency: "USD" },
          is_cash: true,
        },
        ...(quantity === 0
          ? []
          : [
              {
                asset: "GRT",
                account_uuid: "grt-account",
                total_balance_fiat: quantity * 10,
                total_balance_crypto: quantity,
                available_to_trade_fiat: available * 10,
                available_to_trade_crypto: available,
                average_entry_price: { value: "9", currency: "USD" },
                is_cash: false,
              },
            ]),
      ],
    },
  });

const productRules = () =>
  Response.json({
    product_id: "GRT-USD",
    base_increment: "0.01",
    quote_increment: "0.01",
    base_min_size: "0.01",
    trading_disabled: false,
    cancel_only: false,
    view_only: false,
    is_disabled: false,
  });

const sequenceFetch = (
  responses: readonly (Response | Error)[],
): ReturnType<typeof vi.fn<typeof fetch>> => {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  });
};

describe("Coinbase kill control", () => {
  it("cancels product orders, flattens the reconciled balance, and verifies flat", async () => {
    const flattenClientOrderId = deriveCoinbaseControlClientOrderId(
      `kill-cycle-1\u001fcoinbase:portfolio-1:${NOW}\u001f1`,
    );
    const fetchMock = sequenceFetch([
      openOrders(["protective-1"]),
      Response.json({
        results: [
          { success: true, failure_reason: "", order_id: "protective-1" },
        ],
      }),
      openOrders([]),
      portfolio(25, 25),
      openOrders([]),
      Response.json({
        success: true,
        success_response: {
          order_id: "flatten-order-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: flattenClientOrderId,
        },
      }),
      Response.json({
        order: {
          order_id: "flatten-order-1",
          product_id: "GRT-USD",
          client_order_id: flattenClientOrderId,
          side: "SELL",
          status: "FILLED",
          average_filled_price: "10",
          total_fees: "0.10",
          filled_size: "25",
          last_fill_time: "2023-11-14T22:13:20.000Z",
        },
      }),
      portfolio(0),
      openOrders([]),
    ]);

    const result = await executeCoinbaseKill(
      settings,
      product.value,
      { canControl: true, canTrade: true },
      "kill-cycle-1",
      { fetch: fetchMock, now: () => NOW, nonce: () => crypto.randomUUID() },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { totalBaseQuantity: 0, availableBaseQuantity: 0 },
    });
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/api/v3/brokerage/orders") &&
        init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      client_order_id: flattenClientOrderId,
      product_id: "GRT-USD",
      side: "SELL",
      order_configuration: { market_market_ioc: { base_size: "25.00" } },
    });
  });

  it("completes without a sell when the fresh account is already flat", async () => {
    const fetchMock = sequenceFetch([
      openOrders([]),
      portfolio(0),
      openOrders([]),
    ]);
    const result = await executeCoinbaseKill(
      settings,
      product.value,
      { canControl: true, canTrade: true },
      "kill-cycle-flat",
      { fetch: fetchMock, now: () => NOW },
    );

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(3);
  });

  it("never submits a second flatten after an unresolved first outcome", async () => {
    const firstClientOrderId = deriveCoinbaseControlClientOrderId(
      `kill-cycle-unknown\u001fcoinbase:portfolio-1:${NOW}\u001f1`,
    );
    const fetchMock = sequenceFetch([
      openOrders([]),
      portfolio(25, 25),
      openOrders([]),
      new Error("submission outcome unknown"),
      portfolio(25, 25),
      openOrders([]),
    ]);
    const result = await executeCoinbaseKill(
      settings,
      product.value,
      { canControl: true, canTrade: true },
      "kill-cycle-unknown",
      { fetch: fetchMock, now: () => NOW },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ORDER_OUTCOME_UNKNOWN", retryable: false },
    });
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/api/v3/brokerage/orders") &&
        init?.method === "POST",
    );
    expect(createCalls).toHaveLength(1);

    const recoveryNow = NOW + 1;
    const recoveredClientOrderId = deriveCoinbaseControlClientOrderId(
      `kill-cycle-unknown\u001fcoinbase:portfolio-1:${recoveryNow}\u001f1`,
    );
    expect(recoveredClientOrderId).not.toBe(firstClientOrderId);
    const recoveryFetch = sequenceFetch([
      openOrders(["unknown-flatten-1"]),
      Response.json({
        results: [
          {
            success: true,
            failure_reason: "",
            order_id: "unknown-flatten-1",
          },
        ],
      }),
      openOrders([]),
      portfolio(25, 25),
      openOrders([]),
      Response.json({
        success: true,
        success_response: {
          order_id: "recovered-flatten-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: recoveredClientOrderId,
        },
      }),
      Response.json({
        order: {
          order_id: "recovered-flatten-1",
          product_id: "GRT-USD",
          client_order_id: recoveredClientOrderId,
          side: "SELL",
          status: "FILLED",
          average_filled_price: "10",
          total_fees: "0.10",
          filled_size: "25",
          last_fill_time: "2023-11-14T22:13:20.000Z",
        },
      }),
      portfolio(0),
      openOrders([]),
    ]);
    const recovered = await executeCoinbaseKill(
      settings,
      product.value,
      { canControl: true, canTrade: true },
      "kill-cycle-unknown",
      { fetch: recoveryFetch, now: () => recoveryNow },
    );
    expect(recovered.ok).toBe(true);
    const recoveredCreate = recoveryFetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/api/v3/brokerage/orders") &&
        init?.method === "POST",
    );
    expect(JSON.parse(String(recoveredCreate?.[1]?.body))).toMatchObject({
      client_order_id: recoveredClientOrderId,
    });
  });

  it("rejects kill without control permission before touching Coinbase", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await executeCoinbaseKill(
      settings,
      product.value,
      { canControl: false, canTrade: true },
      "kill-cycle-denied",
      { fetch: fetchMock, now: () => NOW },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONTROL_PERMISSION_REQUIRED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Coinbase protected SELL control", () => {
  it("cancels owned protection, sells, reconciles and re-arms the residual", async () => {
    const residualClientOrderId = deriveCoinbaseControlClientOrderId(
      `${sellIntent.clientOrderId}\u001fresidual`,
    );
    const fetchMock = sequenceFetch([
      openOrders(["protective-1"]),
      Response.json({
        results: [
          { success: true, failure_reason: "", order_id: "protective-1" },
        ],
      }),
      openOrders([]),
      portfolio(20),
      Response.json({
        success: true,
        success_response: {
          order_id: "sell-order-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: sellIntent.clientOrderId,
        },
      }),
      Response.json({
        order: {
          order_id: "sell-order-1",
          product_id: "GRT-USD",
          client_order_id: sellIntent.clientOrderId,
          side: "SELL",
          status: "FILLED",
          average_filled_price: "10",
          total_fees: "0.10",
          filled_size: "10",
          last_fill_time: "2023-11-14T22:13:20.000Z",
        },
      }),
      portfolio(10),
      productRules(),
      Response.json({
        success: true,
        success_response: {
          order_id: "residual-protection-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: residualClientOrderId,
        },
      }),
      productRules(),
      Response.json({
        order: {
          order_id: "residual-protection-1",
          product_id: "GRT-USD",
          client_order_id: residualClientOrderId,
          side: "SELL",
          status: "OPEN",
          average_filled_price: "0",
          total_fees: "0",
          filled_size: "0",
          order_configuration: {
            trigger_bracket_gtc: {
              base_size: "10.00",
              limit_price: "9.27",
              stop_trigger_price: "8.87",
            },
          },
        },
      }),
    ]);

    const result = await executeCoinbaseProtectedSell(
      settings,
      sellIntent,
      { canControl: true, canTrade: true },
      ["protective-1"],
      { stopLossBps: 150, takeProfitBps: 300 },
      { fetch: fetchMock, now: () => NOW, nonce: () => crypto.randomUUID() },
    );

    expect(result).toMatchObject({
      status: "CONFIRMED",
      exchangeOrderId: "sell-order-1",
      protectiveOrderId: "residual-protection-1",
      portfolio: { positionQuantity: 10, averagePrice: 9 },
    });
  });

  it("returns NO_SELL_NEEDED with fresh account facts when protection already closed", async () => {
    const fetchMock = sequenceFetch([
      openOrders(["protective-1"]),
      Response.json({
        results: [
          { success: true, failure_reason: "", order_id: "protective-1" },
        ],
      }),
      openOrders([]),
      portfolio(0),
    ]);

    const result = await executeCoinbaseProtectedSell(
      settings,
      sellIntent,
      { canControl: true, canTrade: true },
      ["protective-1"],
      { stopLossBps: 150, takeProfitBps: 300 },
      { fetch: fetchMock, now: () => NOW },
    );

    expect(result).toMatchObject({
      status: "NO_SELL_NEEDED",
      portfolio: { positionQuantity: 0 },
      accountEquity: 1_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("flattens and returns a terminal protection failure when residual confirmation disagrees", async () => {
    const residualClientOrderId = deriveCoinbaseControlClientOrderId(
      `${sellIntent.clientOrderId}\u001fresidual`,
    );
    const safetyClientOrderId = deriveCoinbaseControlClientOrderId(
      `sell-safety-${sellIntent.clientOrderId}\u001fcoinbase:portfolio-1:${NOW}\u001f1`,
    );
    const fetchMock = sequenceFetch([
      openOrders(["protective-1"]),
      Response.json({
        results: [
          { success: true, failure_reason: "", order_id: "protective-1" },
        ],
      }),
      openOrders([]),
      portfolio(20),
      Response.json({
        success: true,
        success_response: {
          order_id: "sell-order-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: sellIntent.clientOrderId,
        },
      }),
      Response.json({
        order: {
          order_id: "sell-order-1",
          product_id: "GRT-USD",
          client_order_id: sellIntent.clientOrderId,
          side: "SELL",
          status: "FILLED",
          average_filled_price: "10",
          total_fees: "0.10",
          filled_size: "10",
          last_fill_time: "2023-11-14T22:13:20.000Z",
        },
      }),
      portfolio(10),
      productRules(),
      Response.json({
        success: true,
        success_response: {
          order_id: "residual-protection-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: residualClientOrderId,
        },
      }),
      productRules(),
      Response.json({
        order: {
          order_id: "residual-protection-1",
          product_id: "GRT-USD",
          client_order_id: residualClientOrderId,
          side: "SELL",
          status: "OPEN",
          average_filled_price: "0",
          total_fees: "0",
          filled_size: "0",
          order_configuration: {
            trigger_bracket_gtc: {
              base_size: "10.00",
              limit_price: "999.00",
              stop_trigger_price: "8.87",
            },
          },
        },
      }),
      openOrders(["residual-protection-1"]),
      Response.json({
        results: [
          {
            success: true,
            failure_reason: "",
            order_id: "residual-protection-1",
          },
        ],
      }),
      openOrders([]),
      portfolio(10),
      openOrders([]),
      Response.json({
        success: true,
        success_response: {
          order_id: "safety-flatten-1",
          product_id: "GRT-USD",
          side: "SELL",
          client_order_id: safetyClientOrderId,
        },
      }),
      Response.json({
        order: {
          order_id: "safety-flatten-1",
          product_id: "GRT-USD",
          client_order_id: safetyClientOrderId,
          side: "SELL",
          status: "FILLED",
          average_filled_price: "10",
          total_fees: "0.10",
          filled_size: "10",
          last_fill_time: "2023-11-14T22:13:20.000Z",
        },
      }),
      portfolio(0),
      openOrders([]),
    ]);

    const result = await executeCoinbaseProtectedSell(
      settings,
      sellIntent,
      { canControl: true, canTrade: true },
      ["protective-1"],
      { stopLossBps: 150, takeProfitBps: 300 },
      { fetch: fetchMock, now: () => NOW, nonce: () => crypto.randomUUID() },
    );

    expect(result).toMatchObject({
      status: "PROTECTION_FAILED",
      exchangeOrderId: "sell-order-1",
      portfolio: { positionQuantity: 0 },
      error: { code: "INVALID_RESPONSE", retryable: false },
    });
  });
});
