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
