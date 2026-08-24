import { describe, expect, it, vi } from "vitest";

import {
  handleDashboardEdgeRequest,
  type DashboardEdgeEnv,
} from "../cloudflare/index.js";

const createEnv = () => {
  const assetFetch = vi.fn(async () => new Response("asset"));
  const apiFetch = vi.fn(async () => Response.json({ ok: true }));
  const authRateLimit = vi.fn(
    async (_options: { readonly key: string }) => ({ success: true }),
  );
  const env: DashboardEdgeEnv = {
    ASSETS: { fetch: assetFetch } as unknown as Fetcher,
    DASHBOARD_API: { fetch: apiFetch } as unknown as Fetcher,
    AUTH_RATE_LIMITER: { limit: authRateLimit },
  };
  return { env, assetFetch, apiFetch, authRateLimit };
};

describe("dashboard Cloudflare edge", () => {
  it("serves health without touching either upstream binding", async () => {
    const { env, assetFetch, apiFetch, authRateLimit } = createEnv();
    const response = await handleDashboardEdgeRequest(
      new Request("https://dodash.example/health"),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "dodash-dashboard",
    });
    expect(assetFetch).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(authRateLimit).not.toHaveBeenCalled();
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("forwards API requests unchanged to the private dashboard API", async () => {
    const { env, assetFetch, apiFetch, authRateLimit } = createEnv();
    const request = new Request("https://dodash.example/api/agents/btc/state", {
      headers: { authorization: "Bearer dashboard-token" },
    });

    const response = await handleDashboardEdgeRequest(request, env);

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledWith(request);
    expect(assetFetch).not.toHaveBeenCalled();
    expect(authRateLimit).toHaveBeenCalledOnce();
    const limiterKey = authRateLimit.mock.calls[0]?.[0].key;
    expect(limiterKey).toMatch(/^dashboard-api:[a-f0-9]{64}$/);
    expect(limiterKey).not.toContain("dashboard-token");
  });

  it("serves every non-API route from the static asset binding", async () => {
    const { env, assetFetch, apiFetch, authRateLimit } = createEnv();
    const request = new Request("https://dodash.example/history/cycle-1");

    expect(await (await handleDashboardEdgeRequest(request, env)).text()).toBe("asset");
    expect(assetFetch).toHaveBeenCalledWith(request);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(authRateLimit).not.toHaveBeenCalled();
  });

  it("does not treat an api-prefixed asset name as a control route", async () => {
    const { env, assetFetch, apiFetch } = createEnv();
    const request = new Request("https://dodash.example/api-client.js");

    await handleDashboardEdgeRequest(request, env);

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the API rate limiter denies the request", async () => {
    const { env, apiFetch, authRateLimit } = createEnv();
    authRateLimit.mockResolvedValueOnce({ success: false });

    const response = await handleDashboardEdgeRequest(
      new Request("https://dodash.example/api/agents/btc/command", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the API rate limiter is unavailable", async () => {
    const { env, apiFetch, authRateLimit } = createEnv();
    authRateLimit.mockRejectedValueOnce(new Error("binding unavailable"));

    const response = await handleDashboardEdgeRequest(
      new Request("https://dodash.example/api/agents/btc/state"),
      env,
    );

    expect(response.status).toBe(503);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("adds the public security headers to assets and generated errors", async () => {
    const { env, authRateLimit } = createEnv();
    const assetResponse = await handleDashboardEdgeRequest(
      new Request("https://dodash.example/"),
      env,
    );

    expect(assetResponse.headers.get("content-security-policy")).toBe(
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
    );
    expect(assetResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(assetResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(assetResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(assetResponse.headers.get("permissions-policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );

    authRateLimit.mockResolvedValueOnce({ success: false });
    const limitedResponse = await handleDashboardEdgeRequest(
      new Request("https://dodash.example/api"),
      env,
    );
    expect(limitedResponse.headers.get("x-frame-options")).toBe("DENY");
  });
});
