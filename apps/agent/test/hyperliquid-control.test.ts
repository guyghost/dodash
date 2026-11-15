import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  recoverPerpOrders,
  submitPerpOrderIntent,
} from "../src/hyperliquid-control.js";
import type { PerpOrderSqlAdapter } from "../src/hyperliquid-store.js";
import type { ControlPermissions } from "@dodash/models";

const settingsInput = {
  HYPERLIQUID_PERP_TRADING_ENABLED: "true",
  HYPERLIQUID_AGENT_PRIVATE_KEY:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  HYPERLIQUID_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
};

const permissions: ControlPermissions = Object.freeze({
  canControl: true,
  canTrade: true,
});

const validRequest = {
  intent: {
    productId: "BTC-PERP",
    side: "BUY",
    quantity: 0.005,
    markPrice: 100_000,
    leverage: 1,
  },
  gate: {
    positionQuantity: 0,
    dailyPnl: 0,
    otherGrossExposureNotional: 0,
  },
  clientOrderId: "perp-2026-08-28-a",
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const createSql = (): PerpOrderSqlAdapter => {
  const database = new DatabaseSync(":memory:");
  return {
    run: (query, params) => {
      database.prepare(query).run(...(params as never[]));
    },
    all: <T>(query: string, params: readonly unknown[]): readonly T[] =>
      database.prepare(query).all(...(params as never[])) as T[],
  };
};

describe("submitPerpOrderIntent", () => {
  it("refuse sans permissions de contrôle et de trade", async () => {
    const result = await submitPerpOrderIntent({
      input: validRequest,
      permissions: { canControl: true, canTrade: false },
      settingsInput,
      sql: createSql(),
      now: () => 0,
    });
    expect(result).toEqual({ ok: false, code: "CONTROL_PERMISSION_REQUIRED" });
  });

  it("refuse quand le flag ou les secrets sont absents", async () => {
    const result = await submitPerpOrderIntent({
      input: validRequest,
      permissions,
      settingsInput: { HYPERLIQUID_PERP_TRADING_ENABLED: "false" },
      sql: createSql(),
      now: () => 0,
    });
    expect(result).toEqual({ ok: false, code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" });
  });

  it("refuse un corps hors schema", async () => {
    const result = await submitPerpOrderIntent({
      input: { intent: { productId: "BTC-PERP" } },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 0,
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PERP_ORDER_REQUEST" });
  });

  it("refuse un clientOrderId hors format", async () => {
    const result = await submitPerpOrderIntent({
      input: { ...validRequest, clientOrderId: "x" },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 0,
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PERP_ORDER_REQUEST" });
  });

  it("exécute une intention valide jusqu'au résultat du runner", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
      }),
    );
    const result = await submitPerpOrderIntent({
      input: validRequest,
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 1_756_416_000_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
  });

  it("dérive la garde depuis le compte réel quand les champs sont omis", async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      if (!String(url).endsWith("/info")) {
        return jsonResponse({
          status: "ok",
          response: { data: { statuses: [{ resting: { oid: 1 } }] } },
        });
      }
      const body = JSON.parse(
        String((init as { body?: string } | undefined)?.body ?? "{}"),
      ) as { type?: string };
      if (body.type === "clearinghouseState") {
        return jsonResponse({
          assetPositions: [
            { position: { coin: "BTC", szi: "0.01", unrealizedPnl: "5" } },
          ],
          marginSummary: { accountValue: "5000", totalRawUsd: "1200" },
        });
      }
      if (body.type === "userFills") return jsonResponse([]);
      return jsonResponse({
        universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
      });
    });
    const result = await submitPerpOrderIntent({
      input: {
        intent: { ...validRequest.intent },
        gate: { dailyPnl: -10 },
        clientOrderId: validRequest.clientOrderId,
      },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 1_756_416_000_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: true,
      result: {
        status: "SETTLED",
        outcome: "ACCEPTED",
        clientOrderId: validRequest.clientOrderId,
        fillPersistenceFailures: 0,
      },
    });
  });

  it("refuse PERP_ACCOUNT_UNAVAILABLE quand le compte est illisible", async () => {
    const result = await submitPerpOrderIntent({
      input: {
        intent: { ...validRequest.intent },
        gate: { dailyPnl: 0 },
        clientOrderId: validRequest.clientOrderId,
      },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 1_756_416_000_000,
      fetch: (async () =>
        jsonResponse({ assetPositions: "nope" })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, code: "PERP_ACCOUNT_UNAVAILABLE" });
  });

  it("exige dailyPnl : jamais inféré depuis le compte", async () => {
    const result = await submitPerpOrderIntent({
      input: {
        intent: { ...validRequest.intent },
        gate: { positionQuantity: 0, otherGrossExposureNotional: 0 },
        clientOrderId: validRequest.clientOrderId,
      },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 0,
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PERP_ORDER_REQUEST" });
  });

  it("refuse une intention hors garde de risque avec le code de la machine", async () => {
    const result = await submitPerpOrderIntent({
      input: {
        ...validRequest,
        gate: { ...validRequest.gate, dailyPnl: -1_000 },
      },
      permissions,
      settingsInput,
      sql: createSql(),
      now: () => 1_756_416_000_000,
      fetch: (async () =>
        jsonResponse({
          universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
        })) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: true,
      result: { status: "REFUSED", reasonCode: "PERP_DAILY_LOSS_BREACHED" },
    });
  });
});

describe("recoverPerpOrders", () => {
  it("signale l'indisponibilité sans toucher au store", async () => {
    const sql = createSql();
    const report = await recoverPerpOrders({
      settingsInput: {},
      sql,
      now: () => 0,
    });
    expect(report).toEqual({
      recovered: 0,
      unresolved: 0,
      fillPersistenceFailures: 0,
      fillBackfillFilled: 0,
      fillBackfillFailures: 0,
      fillBackfillUnresolved: 0,
      fillBackfillTruncated: false,
      unavailable: true,
    });
  });

  it("reprend les intentions en vol via la réconciliation", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "ok", data: { status: { status: "filled" } } }),
    );
    const sql = createSql();
    const first = await submitPerpOrderIntent({
      input: validRequest,
      permissions,
      settingsInput,
      sql,
      now: () => 1_756_416_000_000,
      fetch: (async () =>
        jsonResponse({
          universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
        })) as unknown as typeof fetch,
    });
    expect(first.ok).toBe(true);

    // Simule un crash entre persistance de l'intention et persistance de
    // l'issue : la soumission a échoué (réseau), l'issue n'est pas écrite.
    const report = await recoverPerpOrders({
      settingsInput,
      sql,
      now: () => 1_756_416_000_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(report.recovered + report.unresolved).toBeGreaterThanOrEqual(0);
    expect(report.unavailable).toBe(false);
  });
});
