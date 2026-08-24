import { generateKeyPairSync } from "node:crypto";
import { createProductId } from "@dodash/domain";
import { describe, expect, it, vi } from "vitest";

import {
  coinbasePortfolioPath,
  reconcileCoinbaseAccount,
} from "../src/coinbase-account.js";
import type { CoinbaseExecutionSettings } from "../src/coinbase-execution.js";

const NOW = 1_700_000_000_000;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const settings: CoinbaseExecutionSettings = Object.freeze({
  apiBaseUrl: "https://api.coinbase.com",
  apiKeyId: "organizations/org/apiKeys/key",
  privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
  portfolioId: "portfolio-1",
});
const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const breakdown = () => ({
  breakdown: {
    portfolio: {
      name: "Live",
      uuid: settings.portfolioId,
      type: "DEFAULT",
      deleted: false,
    },
    portfolio_balances: {
      total_balance: { value: "12500", currency: "USD" },
      total_cash_equivalent_balance: { value: "9000", currency: "USD" },
      total_crypto_balance: { value: "3500", currency: "USD" },
    },
    spot_positions: [
      {
        asset: "USD",
        account_uuid: "usd-account",
        total_balance_fiat: 9000,
        total_balance_crypto: 9000,
        available_to_trade_fiat: 8800,
        available_to_trade_crypto: 8800,
        average_entry_price: { value: "1", currency: "USD" },
        is_cash: true,
      },
      {
        asset: "BTC",
        account_uuid: "btc-account",
        total_balance_fiat: 3000,
        total_balance_crypto: 0.05,
        available_to_trade_fiat: 2400,
        available_to_trade_crypto: 0.04,
        average_entry_price: { value: "55000", currency: "USD" },
        is_cash: false,
      },
      {
        asset: "ETH",
        account_uuid: "eth-account",
        total_balance_fiat: 500,
        total_balance_crypto: 0.2,
        available_to_trade_fiat: 500,
        available_to_trade_crypto: 0.2,
        average_entry_price: { value: "2000", currency: "USD" },
        is_cash: false,
      },
    ],
  },
});

describe("Coinbase account reconciliation", () => {
  it("derives cash, total position, account equity and other exposure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(breakdown()));

    const result = await reconcileCoinbaseAccount(settings, product.value, {
      fetch: fetchMock,
      now: () => NOW,
      nonce: () => "0123456789abcdef0123456789abcdef",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        snapshotId: `coinbase:${settings.portfolioId}:${NOW}`,
        observedAt: NOW,
        portfolioId: settings.portfolioId,
        portfolio: {
          cash: 8800,
          positionQuantity: 0.05,
          averagePrice: 55000,
        },
        accountEquity: 12500,
        targetExposureNotional: 3000,
        otherExposureNotional: 500,
        availableBaseQuantity: 0.04,
        totalBaseQuantity: 0.05,
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.coinbase.com${coinbasePortfolioPath(settings.portfolioId)}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      accept: "application/json",
    });
  });

  it("represents an absent target asset as a real zero position", async () => {
    const body = breakdown();
    body.breakdown.spot_positions = body.breakdown.spot_positions.filter(
      (position) => position.asset !== "BTC",
    );
    body.breakdown.portfolio_balances.total_balance.value = "9500";
    body.breakdown.portfolio_balances.total_crypto_balance.value = "500";

    const result = await reconcileCoinbaseAccount(settings, product.value, {
      fetch: vi.fn<typeof fetch>(async () => Response.json(body)),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        portfolio: { positionQuantity: 0, averagePrice: 0 },
        totalBaseQuantity: 0,
        availableBaseQuantity: 0,
        otherExposureNotional: 500,
      },
    });
  });

  it.each([
    ["portfolio mismatch", (body: ReturnType<typeof breakdown>) => {
      body.breakdown.portfolio.uuid = "another-portfolio";
    }],
    ["non-USD total", (body: ReturnType<typeof breakdown>) => {
      body.breakdown.portfolio_balances.total_balance.currency = "EUR";
    }],
    ["duplicate target", (body: ReturnType<typeof breakdown>) => {
      const target = body.breakdown.spot_positions[1];
      if (target !== undefined) body.breakdown.spot_positions.push({ ...target });
    }],
    ["components exceed equity", (body: ReturnType<typeof breakdown>) => {
      body.breakdown.portfolio_balances.total_balance.value = "100";
    }],
  ])("rejects %s instead of inventing account facts", async (_label, mutate) => {
    const body = breakdown();
    mutate(body);
    const result = await reconcileCoinbaseAccount(settings, product.value, {
      fetch: vi.fn<typeof fetch>(async () => Response.json(body)),
      now: () => NOW,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "reconciliation",
        code: "INVALID_RESPONSE",
        retryable: false,
      },
    });
  });

  it("maps network and server failures to retryable reconciliation", async () => {
    const network = await reconcileCoinbaseAccount(settings, product.value, {
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      now: () => NOW,
    });
    const server = await reconcileCoinbaseAccount(settings, product.value, {
      fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
      now: () => NOW,
    });

    expect(network).toMatchObject({
      ok: false,
      error: { code: "RECONCILIATION_FAILURE", retryable: true },
    });
    expect(server).toEqual(network);
  });
});
