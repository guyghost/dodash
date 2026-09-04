import { describe, expect, it, vi } from "vitest";

import type { TradingEnv } from "../src/trading-agent.js";

vi.mock("agents", () => ({
  Agent: class {},
  routeAgentRequest: vi.fn(),
}));

const { handleWorkerRequest } = await import("../src/worker.js");

const token = "a".repeat(32);

describe("Agent Worker live preflight route", () => {
  it("routes an authenticated read-only preflight without starting the Agent", async () => {
    const preflightLive = vi.fn(async () => ({
      ok: true as const,
      report: {
        productId: "GRT-USD",
        assessment: { status: "APPROVED" as const },
        evidence: {
          liveTradingDisabled: true,
          credentialsConfigured: true,
          telemetryConfigured: true,
          operatorNotificationsConfigured: true,
          keyCanView: true,
          keyCanTrade: true,
          keyCanTransfer: false,
          keyPortfolioMatches: true,
          productAllowed: true,
          accountReconciled: true,
          allOpenOrdersOwned: true,
          productRulesValid: true,
        },
        observedAt: 1,
        openOrderCount: 0,
      },
    }));
    const startAgent = vi.fn();
    const env = {
      CONTROL_API_TOKEN: token,
      TRADING_AGENT: {
        getByName: () => ({ preflightLive, startAgent }),
      },
    } as unknown as TradingEnv;
    const response = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/grt-usd--multi/preflight", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ productId: "GRT-USD", executionMode: "live" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(preflightLive).toHaveBeenCalledOnce();
    expect(startAgent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      report: { assessment: { status: "APPROVED" } },
    });
  });

  it("routes an authenticated portfolio summary read and fails closed on projection error", async () => {
    const summary = {
      ok: true as const,
      value: {
        kind: "portfolio" as const,
        phase: "running",
        killSwitchActive: false,
        products: [
          {
            productId: "BTC-USD",
            phase: "waiting",
            status: "running",
            cash: 9_800,
            positionQuantity: 0.1,
            averagePrice: 60_000,
            marketPrice: 62_000,
            grossExposure: 6_200,
            maxGrossExposure: 20_000,
            dailyPnl: 42.5,
            lastCycle: null,
          },
        ],
        consolidated: {
          grossExposure: 6_200,
          maxGrossExposure: 30_000,
          dailyPnl: 42.5,
          maxDailyLoss: 1_500,
        },
      },
    };
    const getPortfolioSummary = vi.fn(() => summary);
    const env = {
      CONTROL_API_TOKEN: token,
      TRADING_AGENT: { getByName: () => ({ getPortfolioSummary }) },
    } as unknown as TradingEnv;
    const response = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/btc-usd--multi/portfolio", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(getPortfolioSummary).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual(summary);

    const failing = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/btc-usd--multi/portfolio", {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        ...env,
        TRADING_AGENT: {
          getByName: () => ({
            getPortfolioSummary: () => ({
              ok: false as const,
              error: { code: "INVALID_PORTFOLIO_SESSION" },
            }),
          }),
        },
      } as unknown as TradingEnv,
    );
    expect(failing.status).toBe(500);
    await expect(failing.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_PORTFOLIO_SESSION" },
    });
  });

  it("rejects an unauthenticated portfolio read before touching the Agent", async () => {
    const getPortfolioSummary = vi.fn();
    const env = {
      CONTROL_API_TOKEN: token,
      TRADING_AGENT: { getByName: () => ({ getPortfolioSummary }) },
    } as unknown as TradingEnv;
    const response = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/btc-usd--multi/portfolio"),
      env,
    );
    expect(response.status).toBe(401);
    expect(getPortfolioSummary).not.toHaveBeenCalled();
  });

  it("routes an authenticated pnl read and fails closed on projection error", async () => {
    const history = {
      ok: true as const,
      value: {
        equityCurve: [],
        cycles: [],
        openPosition: null,
        protection: null,
      },
    };
    const getPnlHistory = vi.fn(() => history);
    const env = {
      CONTROL_API_TOKEN: token,
      TRADING_AGENT: { getByName: () => ({ getPnlHistory }) },
    } as unknown as TradingEnv;
    const response = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/btc-usd--multi/pnl?limit=30", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(getPnlHistory).toHaveBeenCalledWith(30);
    await expect(response.json()).resolves.toEqual(history);

    const failing = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/btc-usd--multi/pnl?limit=30", {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        ...env,
        TRADING_AGENT: {
          getByName: () => ({
            getPnlHistory: () => ({
              ok: false as const,
              error: { code: "INVALID_ARTIFACTS_JSON" },
            }),
          }),
        },
      } as unknown as TradingEnv,
    );
    expect(failing.status).toBe(500);
    await expect(failing.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_ARTIFACTS_JSON" },
    });
  });

  it("rejects preflight without the control token", async () => {
    const getByName = vi.fn();
    const env = {
      CONTROL_API_TOKEN: token,
      TRADING_AGENT: { getByName },
    } as unknown as TradingEnv;
    const response = await handleWorkerRequest(
      new Request("https://agent.test/api/agents/grt-usd--multi/preflight", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
  });
});
