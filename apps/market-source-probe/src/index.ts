import { isMarketProbeWindowOpen, type MarketProbeInput } from "@dodash/models";
import { runMarketProbe } from "./run.js";

export interface ProbeEnv {
  readonly DIAGNOSTIC_TOKEN?: string;
  readonly PROBE_ENABLED?: string;
  readonly PROBE_STARTED_AT?: string;
  readonly PROBE_EXPIRES_AT?: string;
}
const configuration = (env: ProbeEnv): MarketProbeInput => ({
  enabled: env.PROBE_ENABLED === "true", startedAt: Number(env.PROBE_STARTED_AT),
  expiresAt: Number(env.PROBE_EXPIRES_AT), requestCount: 15,
});
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: {
  "cache-control": "no-store", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "strict-transport-security": "max-age=31536000",
} });
const authorized = (request: Request, env: ProbeEnv): boolean => {
  const expected = env.DIAGNOSTIC_TOKEN;
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  if (expected === undefined || expected.length < 32 || expected.length > 256 || supplied?.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return difference === 0;
};

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const input = configuration(env);
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "market-source-probe", active: isMarketProbeWindowOpen(input, Date.now()), expiresAt: Number.isSafeInteger(input.expiresAt) ? input.expiresAt : null });
    if (url.pathname !== "/probe") return json({ error: "NOT_FOUND" }, 404);
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (!authorized(request, env)) return json({ error: "UNAUTHORIZED" }, 401);
    if (url.search !== "") return json({ error: "NO_PARAMETERS_ALLOWED" }, 400);
    if (request.body !== null) {
      const reader = request.body.getReader();
      try {
        const first = await reader.read();
        if (!first.done) {
          await reader.cancel();
          return json({ error: "NO_PARAMETERS_ALLOWED" }, 400);
        }
      } finally { reader.releaseLock(); }
    }
    if (!isMarketProbeWindowOpen(input, Date.now())) return json({ error: "INACTIVE" }, 410);
    const report = await runMarketProbe(input);
    return json({ ...report, colo: (request as Request & { cf?: { colo?: string } }).cf?.colo ?? null });
  },
  async scheduled(_event: unknown, env: ProbeEnv): Promise<void> {
    const input = configuration(env);
    if (!isMarketProbeWindowOpen(input, Date.now())) return;
    const report = await runMarketProbe(input);
    console.log(JSON.stringify({ type: "market_source_probe.completed", ...report }));
  },
};
