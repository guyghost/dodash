import type { ControlPermissions } from "@dodash/models";
import { routeAgentRequest } from "agents";

import { hasValidBearerToken } from "./auth.js";
import { readBoundedJson } from "./bounded-json.js";
import { TradingAgent, type TradingEnv } from "./trading-agent.js";

const MAX_CONTROL_REQUEST_BYTES = 32_768;
const permissions: ControlPermissions = Object.freeze({
  canControl: true,
  canTrade: true,
});

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const isAuthorized = (request: Request, env: TradingEnv): boolean => {
  return hasValidBearerToken(
    request.headers.get("authorization"),
    env.CONTROL_API_TOKEN,
  );
};

type TradingAgentRpc = Pick<
  TradingAgent,
  | "getAgentState"
  | "killAgent"
  | "listRecentCycles"
  | "preflightLive"
  | "resetAgent"
  | "runNow"
  | "startAgent"
  | "stopAgent"
>;

const getAgent = (env: TradingEnv, name: string): TradingAgentRpc =>
  env.TRADING_AGENT.getByName(name) as unknown as TradingAgentRpc;

const handleApi = async (
  request: Request,
  env: TradingEnv,
): Promise<Response | null> => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "agents" || segments.length < 3) {
    return null;
  }
  if (!isAuthorized(request, env)) {
    return json({ error: { code: "UNAUTHORIZED" } }, 401);
  }

  const name = segments[2];
  if (name === undefined || name.length === 0 || name.length > 200) {
    return json({ error: { code: "INVALID_AGENT_NAME" } }, 400);
  }
  const action = segments[3] ?? "state";
  const agent = getAgent(env, name);

  if (request.method === "GET" && action === "state") {
    return json(await agent.getAgentState());
  }
  if (request.method === "GET" && action === "cycles") {
    const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    return json(await agent.listRecentCycles(rawLimit));
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST" },
    });
  }

  switch (action) {
    case "preflight": {
      let body: unknown;
      try {
        body = await readBoundedJson(request, MAX_CONTROL_REQUEST_BYTES);
      } catch {
        return json({ error: { code: "INVALID_REQUEST" } }, 400);
      }
      const result = await agent.preflightLive(body, permissions);
      return json(result, result.ok ? 200 : 409);
    }
    case "start": {
      let body: unknown;
      try {
        body = await readBoundedJson(request, MAX_CONTROL_REQUEST_BYTES);
      } catch {
        return json({ error: { code: "INVALID_REQUEST" } }, 400);
      }
      const result = await agent.startAgent(body, permissions);
      return json(result, result.ok ? 200 : 409);
    }
    case "stop":
      return json(await agent.stopAgent(permissions));
    case "kill":
      return json(await agent.killAgent(permissions));
    case "reset":
      return json(await agent.resetAgent(permissions));
    case "tick":
      return json(await agent.runNow());
    default:
      return json({ error: { code: "NOT_FOUND" } }, 404);
  }
};

export const handleWorkerRequest = async (
  request: Request,
  env: TradingEnv,
): Promise<Response> => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health") {
    return json({ status: "ok", service: "dodash-agent" });
  }

  const apiResponse = await handleApi(request, env);
  if (apiResponse !== null) return apiResponse;

  if (pathname.startsWith("/agents/")) {
    if (!isAuthorized(request, env)) {
      return json({ error: { code: "UNAUTHORIZED" } }, 401);
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not Found", { status: 404 });
  }

  return new Response("Not Found", { status: 404 });
};

export { TradingAgent };

export default {
  fetch: handleWorkerRequest,
} satisfies ExportedHandler<TradingEnv>;
