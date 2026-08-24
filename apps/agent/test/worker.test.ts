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
