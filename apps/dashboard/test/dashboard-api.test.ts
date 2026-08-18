import { describe, expect, it, vi } from "vitest";

import {
  DashboardRequestError,
  createHttpGateway,
  parseAgentState,
  parseCycles,
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

describe("dashboard API boundary", () => {
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
