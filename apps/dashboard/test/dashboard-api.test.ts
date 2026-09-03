import { describe, expect, it, vi } from "vitest";

import {
  DashboardRequestError,
  createStartConfiguration,
  createHttpGateway,
  parseAgentState,
  parseCycles,
  parsePnlHistory,
  type PnlHistoryView,
} from "../src/dashboard-api.js";

const state = {
  version: 1,
  enabled: true,
  updatedAt: 1_700_000_000_000,
  configuration: {
    productId: "BTC-USD",
    timeframe: "FIVE_MINUTE",
    strategyIds: ["rsi-reversion"],
    intervalSeconds: 300,
    executionMode: "paper",
  },
  machine: {
    value: "waiting",
    context: { nextWakeAt: 1_700_000_300_000 },
  },
  portfolio: { cash: 9_000, positionQuantity: 0.01, averagePrice: 60_000 },
  dailyPnl: 50,
  lastTradeAt: null,
  lastCycle: {
    cycleId: "cycle-1",
    outcome: "ORDER_CONFIRMED",
    marketPrice: 62_000,
    signalCount: 1,
    completedAt: 1_700_000_000_000,
  },
  previousIndicators: {
    snapshotId: "indicators-1",
    candleClosedAt: 1_700_000_000_000,
    rsi: 52,
    emaFast: 61_000,
    emaSlow: 60_500,
    macd: 500,
    atr: 800,
  },
};

const pnlHistory = {
  equityCurve: [
    { t: 1_700_000_000_000, equity: 6_401.5 },
    { t: 1_700_000_300_000, equity: 6_501.5 },
  ],
  cycles: [
    {
      cycleId: "cycle-2",
      triggeredAt: 1_700_000_300_000,
      completedAt: 1_700_000_304_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 62_000,
      side: "SELL",
      quantity: 0.1,
      fillPrice: 62_010,
      fee: 2,
      realizedPnl: 190.95,
      slippageBps: 1.61,
    },
    {
      cycleId: "cycle-1",
      triggeredAt: 1_700_000_000_000,
      completedAt: 1_700_000_004_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 60_000,
      side: "BUY",
      quantity: 0.1,
      fillPrice: 60_060,
      fee: 1.5,
      realizedPnl: null,
      slippageBps: 10,
    },
  ],
  openPosition: { quantity: 0.1, averagePrice: 60_098.5 },
  protection: {
    stopLossPrice: 58_000,
    takeProfitPrice: 63_000,
    protectiveOrderConfirmed: true,
  },
};

describe("dashboard API boundary", () => {
  it("freezes a live start to the confirmed daily strategy envelope", () => {
    expect(
      createStartConfiguration({
        productId: "GRT-USD",
        timeframe: "FIVE_MINUTE",
        strategyIds: ["rsi-reversion"],
        executionMode: "live",
      }),
    ).toEqual({
      productId: "GRT-USD",
      timeframe: "ONE_DAY",
      strategyIds: ["breakout", "ema-cross", "rsi-reversion"],
      executionMode: "live",
    });
  });

  it("preserves an explicit paper start", () => {
    const paper = {
      productId: "BTC-USD",
      timeframe: "FIVE_MINUTE",
      strategyIds: ["rsi-reversion"],
      executionMode: "paper" as const,
    };
    expect(createStartConfiguration(paper)).toEqual(paper);
  });

  it("projects a validated Agent state", () => {
    expect(parseAgentState(state)).toMatchObject({
      phase: "waiting",
      enabled: true,
      nextWakeAt: 1_700_000_300_000,
      configuration: { productId: "BTC-USD" },
      indicators: { rsi: 52 },
    });
  });

  it("rejects an unknown remote phase", () => {
    expect(() =>
      parseAgentState({
        ...state,
        machine: { value: "whatever-the-server-says", context: {} },
      }),
    ).toThrow(DashboardRequestError);
  });

  it("rejects malformed optional timestamps", () => {
    expect(() =>
      parseAgentState({
        ...state,
        lastTradeAt: "yesterday",
      }),
    ).toThrow(DashboardRequestError);
  });

  it("validates and caps cycle history", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      cycle_id: `cycle-${index}`,
      triggered_at: 1_700_000_000_000 + index,
      completed_at: 1_700_000_001_000 + index,
      phase: "scheduling",
      outcome: "NO_ACTION",
    }));
    expect(parseCycles(rows)).toHaveLength(50);
  });

  it("keeps the dashboard token in the Authorization header", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(state));
    const gateway = createHttpGateway("https://dashboard-api.example/", "secret", request);
    await gateway.loadState("btc agent");

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://dashboard-api.example/api/agents/btc%20agent/state");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    expect(String(url)).not.toContain("secret");
  });
});

describe("pnl history boundary", () => {
  it("projects a validated pnl history", () => {
    const view: PnlHistoryView = parsePnlHistory(pnlHistory);
    expect(view.equityCurve).toHaveLength(2);
    expect(view.cycles[0]).toMatchObject({ cycleId: "cycle-2", realizedPnl: 190.95 });
    expect(view.openPosition).toEqual({ quantity: 0.1, averagePrice: 60_098.5 });
    expect(view.protection).toMatchObject({ protectiveOrderConfirmed: true });
  });

  it("accepts trade-less cycles with null fields", () => {
    const view = parsePnlHistory({
      ...pnlHistory,
      cycles: [
        {
          cycleId: "cycle-3",
          triggeredAt: 1_700_000_600_000,
          completedAt: null,
          outcome: "NO_ACTION",
          marketPrice: null,
          side: null,
          quantity: null,
          fillPrice: null,
          fee: null,
          realizedPnl: null,
          slippageBps: null,
        },
      ],
      openPosition: null,
      protection: null,
    });
    expect(view.cycles[0]).toMatchObject({ side: null, fee: null });
    expect(view.protection).toBeNull();
  });

  it("caps the pnl window like the Agent envelope", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      ...pnlHistory.cycles[0],
      cycleId: `cycle-${index}`,
    }));
    expect(parsePnlHistory({ ...pnlHistory, cycles: rows }).cycles).toHaveLength(50);
  });

  it("rejects malformed pnl records", () => {
    expect(() =>
      parsePnlHistory({
        ...pnlHistory,
        cycles: [{ ...pnlHistory.cycles[0], triggeredAt: "now" }],
      }),
    ).toThrow(DashboardRequestError);
    expect(() =>
      parsePnlHistory({
        ...pnlHistory,
        equityCurve: [{ t: 1, equity: "high" }],
      }),
    ).toThrow(DashboardRequestError);
    expect(() =>
      parsePnlHistory({
        ...pnlHistory,
        protection: { ...pnlHistory.protection, protectiveOrderConfirmed: "yes" },
      }),
    ).toThrow(DashboardRequestError);
    expect(() => parsePnlHistory({ ...pnlHistory, openPosition: {} })).toThrow(
      DashboardRequestError,
    );
  });

  it("keeps the pnl read on the authenticated proxy route", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(pnlHistory));
    const gateway = createHttpGateway("https://dashboard-api.example", "secret", request);
    const view = await gateway.loadPnlHistory("btc agent");

    const [url] = request.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://dashboard-api.example/api/agents/btc%20agent/pnl?limit=30",
    );
    expect(view.cycles).toHaveLength(2);
  });
});
