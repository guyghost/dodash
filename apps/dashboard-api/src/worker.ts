import { hasValidBearerToken } from "./auth.js";
import { BodyLimitError, readBoundedBody } from "./bounded-body.js";

const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1_048_576;
const agentActions = new Set([
  "state",
  "cycles",
  "preflight",
  "start",
  "stop",
  "reset",
  "tick",
  "kill",
]);
const bodyActions = new Set(["preflight", "start"]);

export interface DashboardApiEnv {
  readonly AGENT_SERVICE: Fetcher;
  readonly DASHBOARD_ACCESS_TOKEN: string;
  readonly CONTROL_API_TOKEN: string;
}

interface ParsedRoute {
  readonly name: string;
  readonly encodedName: string;
  readonly action: string;
  readonly search: string;
}

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });

const error = (code: string, status: number, extraHeaders?: HeadersInit): Response =>
  json({ error: { code } }, status, extraHeaders);

const parseRoute = (url: URL): ParsedRoute | null => {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "api" || segments[1] !== "agents") {
    return null;
  }
  const action = segments[3];
  if (action === undefined || !agentActions.has(action)) return null;

  let name: string;
  try {
    name = decodeURIComponent(segments[2] ?? "");
  } catch {
    return null;
  }
  if (
    name.length === 0 ||
    name.length > 200 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f/\\]/u.test(name)
  ) {
    return null;
  }

  if (url.searchParams.size > 0) {
    if (action !== "cycles" || [...url.searchParams.keys()].some((key) => key !== "limit")) {
      return null;
    }
    const rawLimit = url.searchParams.get("limit");
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
  }

  return {
    name,
    encodedName: encodeURIComponent(name),
    action,
    search: url.search,
  };
};

const methodAllowed = (method: string, action: string): boolean =>
  (method === "GET" && (action === "state" || action === "cycles")) ||
  (method === "POST" && action !== "state" && action !== "cycles");

const isSameOrigin = (request: Request, url: URL): boolean => {
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
};

const readJsonBody = async (request: Request): Promise<Uint8Array> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("INVALID_CONTENT_TYPE");
  const bytes = await readBoundedBody(
    request.body,
    request.headers.get("content-length"),
    MAX_REQUEST_BYTES,
  );
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return bytes;
};

const hasUnexpectedBody = async (request: Request): Promise<boolean> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 0) return true;
  if (request.body === null) return false;
  try {
    await readBoundedBody(request.body, request.headers.get("content-length"), 0);
    return false;
  } catch {
    return true;
  }
};

const forwardResponse = async (response: Response): Promise<Response> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel("response too large");
    return error("RESPONSE_TOO_LARGE", 413);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return error("AGENT_UNAVAILABLE", 502);
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) return error("RESPONSE_TOO_LARGE", 413);

  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (response.status === 405) {
    const allow = response.headers.get("allow");
    if (allow !== null) headers.set("allow", allow);
  }
  return new Response(bytes, { status: response.status, headers });
};

export const handleDashboardApiRequest = async (
  request: Request,
  env: DashboardApiEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ status: "ok", service: "dodash-dashboard-api" });
  }

  const route = parseRoute(url);
  if (route === null) return error("NOT_FOUND", 404);
  if (!isSameOrigin(request, url)) return error("CROSS_ORIGIN_FORBIDDEN", 403);
  if (!methodAllowed(request.method, route.action)) {
    const allow = route.action === "state" || route.action === "cycles" ? "GET" : "POST";
    return error("METHOD_NOT_ALLOWED", 405, { allow });
  }
  if (!hasValidBearerToken(request.headers.get("authorization"), env.DASHBOARD_ACCESS_TOKEN)) {
    return error("UNAUTHORIZED", 401);
  }
  if (typeof env.CONTROL_API_TOKEN !== "string" || env.CONTROL_API_TOKEN.length < 32) {
    return error("SERVICE_MISCONFIGURED", 503);
  }

  let body: Uint8Array | undefined;
  if (bodyActions.has(route.action)) {
    try {
      body = await readJsonBody(request);
    } catch (caught) {
      return caught instanceof BodyLimitError
        ? error("REQUEST_TOO_LARGE", 413)
        : error("INVALID_REQUEST", 400);
    }
  } else if (await hasUnexpectedBody(request)) {
    await request.body?.cancel("body forbidden");
    return error("UNEXPECTED_BODY", 400);
  }

  const internalUrl = new URL(
    `/api/agents/${route.encodedName}/${route.action}${route.search}`,
    "https://dodash-agent.internal",
  );
  const headers = new Headers({ authorization: `Bearer ${env.CONTROL_API_TOKEN}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  const internalRequest = new Request(internalUrl, {
    method: request.method,
    headers,
    ...(body === undefined
      ? {}
      : { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer }),
  });

  try {
    return await forwardResponse(await env.AGENT_SERVICE.fetch(internalRequest));
  } catch {
    return error("AGENT_UNAVAILABLE", 502);
  }
};

export default {
  fetch: handleDashboardApiRequest,
} satisfies ExportedHandler<DashboardApiEnv>;
