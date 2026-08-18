import { describe, expect, it, vi } from "vitest";

import {
  handleDashboardEdgeRequest,
  type DashboardEdgeEnv,
} from "../cloudflare/index.js";

const createEnv = () => {
  const assetFetch = vi.fn(async () => new Response("asset"));
  const apiFetch = vi.fn(async () => Response.json({ ok: true }));
  const env: DashboardEdgeEnv = {
    ASSETS: { fetch: assetFetch } as unknown as Fetcher,
    DASHBOARD_API: { fetch: apiFetch } as unknown as Fetcher,
  };
  return { env, assetFetch, apiFetch };
};

describe("dashboard Cloudflare edge", () => {
  it("forwards API requests unchanged to the private dashboard API", async () => {
    const { env, assetFetch, apiFetch } = createEnv();
    const request = new Request("https://dodash.example/api/agents/btc/state", {
      headers: { authorization: "Bearer dashboard-token" },
    });

    const response = await handleDashboardEdgeRequest(request, env);

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledWith(request);
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("serves every non-API route from the static asset binding", async () => {
    const { env, assetFetch, apiFetch } = createEnv();
    const request = new Request("https://dodash.example/history/cycle-1");

    expect(await (await handleDashboardEdgeRequest(request, env)).text()).toBe("asset");
    expect(assetFetch).toHaveBeenCalledWith(request);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("does not treat an api-prefixed asset name as a control route", async () => {
    const { env, assetFetch, apiFetch } = createEnv();
    const request = new Request("https://dodash.example/api-client.js");

    await handleDashboardEdgeRequest(request, env);

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
