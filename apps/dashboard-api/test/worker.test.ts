import { describe, expect, it, vi } from "vitest";

import { handleDashboardApiRequest, type DashboardApiEnv } from "../src/worker.js";

const dashboardToken = "dashboard-token-that-is-at-least-32-characters";
const controlToken = "control-token-that-is-at-least-32-characters";
type TestFetcher = ReturnType<typeof vi.fn<(upstream: Request) => Promise<Response>>>;

const createEnv = (
  fetcher: TestFetcher = vi.fn(async (_upstream: Request) => Response.json({ ok: true })),
): DashboardApiEnv => ({
  AGENT_SERVICE: { fetch: fetcher } as unknown as Fetcher,
  DASHBOARD_ACCESS_TOKEN: dashboardToken,
  CONTROL_API_TOKEN: controlToken,
});

const request = (
  path: string,
  init: RequestInit = {},
): Request =>
  new Request(`https://dashboard.example${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${dashboardToken}`,
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });

describe("dashboard Agent proxy", () => {
  it("serves a public health response without touching the Agent", async () => {
    const env = createEnv();
    const response = await handleDashboardApiRequest(request("/health"), env);
    expect(response.status).toBe(200);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid dashboard credential before the effect", async () => {
    const env = createEnv();
    const response = await handleDashboardApiRequest(
      new Request("https://dashboard.example/api/agents/btc/state"),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when the internal control credential is misconfigured", async () => {
    const env = { ...createEnv(), CONTROL_API_TOKEN: "too-short" };
    const response = await handleDashboardApiRequest(
      request("/api/agents/btc/state"),
      env,
    );
    expect(response.status).toBe(503);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin browser requests", async () => {
    const env = createEnv();
    const response = await handleDashboardApiRequest(
      request("/api/agents/btc/state", { headers: { origin: "https://evil.example" } }),
      env,
    );
    expect(response.status).toBe(403);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("rejects paths, queries, and methods outside the allowlist", async () => {
    const env = createEnv();
    const responses = await Promise.all([
      handleDashboardApiRequest(request("/api/agents/btc/delete"), env),
      handleDashboardApiRequest(request("/api/agents/btc/state?redirect=evil"), env),
      handleDashboardApiRequest(request("/api/agents/btc/state", { method: "POST" }), env),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 405]);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("normalizes the Agent path and injects only the internal credential", async () => {
    const fetcher = vi.fn(async (upstream: Request) => {
      expect(upstream.url).toBe("https://dodash-agent.internal/api/agents/btc%20agent/cycles?limit=12");
      expect(upstream.headers.get("authorization")).toBe(`Bearer ${controlToken}`);
      expect(upstream.headers.get("x-forward-me")).toBeNull();
      return Response.json([{ cycle_id: "cycle-1" }]);
    });
    const response = await handleDashboardApiRequest(
      request("/api/agents/btc%20agent/cycles?limit=12", {
        headers: { "x-forward-me": "never" },
      }),
      createEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("forwards a validated start JSON body", async () => {
    const fetcher = vi.fn(async (upstream: Request) => {
      expect(upstream.method).toBe("POST");
      expect(upstream.headers.get("content-type")).toBe("application/json");
      expect(await upstream.json()).toEqual({ productId: "BTC-USD" });
      return Response.json({ ok: true, state: { enabled: true } });
    });
    const response = await handleDashboardApiRequest(
      request("/api/agents/btc/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: "BTC-USD" }),
      }),
      createEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("forwards a validated live-off preflight JSON body", async () => {
    const fetcher = vi.fn(async (upstream: Request) => {
      expect(upstream.url).toBe(
        "https://dodash-agent.internal/api/agents/grt-usd--multi/preflight",
      );
      expect(await upstream.json()).toEqual({
        productId: "GRT-USD",
        executionMode: "live",
      });
      return Response.json({ ok: true, report: { assessment: "APPROVED" } });
    });
    const response = await handleDashboardApiRequest(
      request("/api/agents/grt-usd--multi/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: "GRT-USD",
          executionMode: "live",
        }),
      }),
      createEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts an explicitly streamed but empty command body", async () => {
    const fetcher = vi.fn(async (upstream: Request) => {
      expect(upstream.method).toBe("POST");
      expect(upstream.body).toBeNull();
      return Response.json({ ok: true });
    });
    const response = await handleDashboardApiRequest(
      request("/api/agents/btc/tick", {
        method: "POST",
        body: new Uint8Array(),
      }),
      createEnv(fetcher),
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects invalid, oversized, or unexpected bodies before the effect", async () => {
    const env = createEnv();
    const responses = await Promise.all([
      handleDashboardApiRequest(
        request("/api/agents/btc/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }),
        env,
      ),
      handleDashboardApiRequest(
        request("/api/agents/btc/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "x".repeat(17_000) }),
        }),
        env,
      ),
      handleDashboardApiRequest(
        request("/api/agents/btc/kill", { method: "POST", body: "surprise" }),
        env,
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([400, 413, 400]);
    expect(env.AGENT_SERVICE.fetch).not.toHaveBeenCalled();
  });

  it("bounds Agent responses and maps service failures without retrying", async () => {
    const oversized = createEnv(vi.fn(async () => new Response("x".repeat(1_048_577))));
    const unavailable = createEnv(vi.fn(async () => Promise.reject(new Error("offline"))));
    const [largeResponse, failedResponse] = await Promise.all([
      handleDashboardApiRequest(request("/api/agents/btc/state"), oversized),
      handleDashboardApiRequest(request("/api/agents/btc/state"), unavailable),
    ]);
    expect(largeResponse.status).toBe(413);
    expect(failedResponse.status).toBe(502);
    expect(unavailable.AGENT_SERVICE.fetch).toHaveBeenCalledOnce();
  });
});
