import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { preflightCoinbaseLive } from "../src/coinbase-preflight.js";
import type { CoinbaseSettingsInput } from "../src/coinbase-execution.js";

const NOW = 1_700_000_000_000;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const input: CoinbaseSettingsInput = {
  LIVE_TRADING_ENABLED: "false",
  COINBASE_API_BASE_URL: "https://api.coinbase.com",
  COINBASE_API_KEY_ID: "organizations/org/apiKeys/key",
  COINBASE_API_PRIVATE_KEY: privateKey
    .export({ type: "sec1", format: "pem" })
    .toString(),
  COINBASE_PORTFOLIO_ID: "portfolio-1",
  TRADING_TELEMETRY: { binding: true },
  OPERATOR_NOTIFY_WEBHOOK_URL: "https://operator.example.com/hook",
  OPERATOR_NOTIFY_SECRET: "0".repeat(32),
};

const keyPermissions = (canTransfer = false) =>
  Response.json({
    can_view: true,
    can_trade: true,
    can_transfer: canTransfer,
    can_receive: true,
    portfolio_uuid: "portfolio-1",
    portfolio_type: "DEFAULT",
  });

const portfolio = () =>
  Response.json({
    breakdown: {
      portfolio: { uuid: "portfolio-1", deleted: false },
      portfolio_balances: {
        total_balance: { value: "1000", currency: "USD" },
      },
      spot_positions: [
        {
          asset: "USD",
          account_uuid: "usd-account",
          total_balance_fiat: 1000,
          total_balance_crypto: 1000,
          available_to_trade_fiat: 1000,
          available_to_trade_crypto: 1000,
          average_entry_price: { value: "1", currency: "USD" },
          is_cash: true,
        },
      ],
    },
  });

const openOrders = (ids: readonly string[]) =>
  Response.json({
    orders: ids.map((order_id) => ({
      order_id,
      product_id: "GRT-USD",
      status: "OPEN",
    })),
    has_next: false,
    cursor: "",
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

const fetchSequence = (responses: readonly Response[]) => {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("unexpected fetch");
    return response;
  });
};

describe("Coinbase live-off preflight", () => {
  it("approves only read-only evidence with exact portfolio and owned orders", async () => {
    const fetchMock = fetchSequence([
      keyPermissions(),
      portfolio(),
      openOrders(["protection-1"]),
      productRules(),
    ]);
    const report = await preflightCoinbaseLive(
      input,
      "GRT-USD",
      ["protection-1"],
      { fetch: fetchMock, now: () => NOW, nonce: () => crypto.randomUUID() },
    );

    expect(report.assessment).toEqual({ status: "APPROVED" });
    expect(report.openOrderCount).toBe(1);
    expect(
      fetchMock.mock.calls.every(([, request]) => request?.method === "GET"),
    ).toBe(true);
  });

  it("refuses live when the operator notification channel is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const {
      OPERATOR_NOTIFY_WEBHOOK_URL: _webhookUrl,
      OPERATOR_NOTIFY_SECRET: _secret,
      ...inputWithoutNotifications
    } = input;
    const report = await preflightCoinbaseLive(
      inputWithoutNotifications,
      "GRT-USD",
      [],
      { fetch: fetchMock, now: () => NOW },
    );
    expect(report.evidence.operatorNotificationsConfigured).toBe(false);
    expect(report.assessment).toEqual({
      status: "REJECTED",
      reasonCode: "OPERATOR_NOTIFICATIONS_MISSING",
    });
  });

  it("rejects a transfer-capable key", async () => {
    const fetchMock = fetchSequence([
      keyPermissions(true),
      portfolio(),
      openOrders([]),
      productRules(),
    ]);
    const report = await preflightCoinbaseLive(input, "GRT-USD", [], {
      fetch: fetchMock,
      now: () => NOW,
    });
    expect(report.assessment).toEqual({
      status: "REJECTED",
      reasonCode: "KEY_PERMISSION_MISMATCH",
    });
  });

  it("rejects an open order absent from persisted Agent protections", async () => {
    const fetchMock = fetchSequence([
      keyPermissions(),
      portfolio(),
      openOrders(["foreign-order"]),
      productRules(),
    ]);
    const report = await preflightCoinbaseLive(input, "GRT-USD", [], {
      fetch: fetchMock,
      now: () => NOW,
    });
    expect(report.assessment).toEqual({
      status: "REJECTED",
      reasonCode: "ORDER_OWNERSHIP_DRIFT",
    });
  });

  it("refuses before network access when live execution is already enabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const report = await preflightCoinbaseLive(
      { ...input, LIVE_TRADING_ENABLED: "true" },
      "GRT-USD",
      [],
      { fetch: fetchMock, now: () => NOW },
    );
    expect(report.assessment).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_MUST_BE_DISABLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
