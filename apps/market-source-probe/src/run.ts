import { createActor } from "xstate";
import { marketSourceProbeMachine, type MarketProbeInput } from "@dodash/models";
import { compareLatestCloses, normalizeProbePayload, type CandleSummary, type QuoteSummary } from "./normalize.js";
import { DAY, planProbeRequests, type ProbeRequest } from "./plan.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export interface ProbeObservation {
  readonly request: ProbeRequest;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly status: number | null;
  readonly outcome: "OK" | "HTTP_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "SKIPPED_RATE_LIMIT";
  readonly retryAfter: string | null;
  readonly cacheStatus: string | null;
  readonly bodySha256: string | null;
  readonly data?: CandleSummary | QuoteSummary;
}

const readBounded = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
};

export const runMarketProbe = async (input: MarketProbeInput, deps: { fetch?: typeof fetch; now?: () => number } = {}) => {
  const now = deps.now ?? Date.now;
  const fetcher = (deps.fetch ?? globalThis.fetch).bind(globalThis);
  const startedAt = now();
  const actor = createActor(marketSourceProbeMachine, { input }).start();
  actor.send({ type: "START", now: startedAt });
  const observations: ProbeObservation[] = [];
  const closedAt = Math.floor(startedAt / DAY) * DAY;
  try {
    if (actor.getSnapshot().value === "running") for (const request of planProbeRequests(startedAt)) {
      const at = now();
      if (at >= input.expiresAt) { actor.send({ type: "EXPIRE" }); break; }
      let result: ProbeObservation = { request, startedAt: at, completedAt: at, status: null,
        outcome: "SKIPPED_RATE_LIMIT", retryAfter: null, cacheStatus: null, bodySha256: null };
      if (!actor.getSnapshot().context.blockedProviders.includes(request.provider)) {
        let response: Response | undefined;
        try {
          response = await fetcher(request.url, {
            method: request.body === undefined ? "GET" : "POST",
            headers: { accept: "application/json", "content-type": "application/json", "user-agent": "DoDash-Market-Source-Probe/1.0" },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            redirect: "manual", credentials: "omit",
            signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, input.expiresAt - at))),
          });
          result = { ...result, status: response.status, outcome: "HTTP_ERROR",
            retryAfter: response.headers.get("retry-after")?.slice(0, 64) ?? null,
            cacheStatus: response.headers.get("cf-cache-status")?.slice(0, 64) ?? null };
          if (response.ok) {
            const raw = await readBounded(response);
            const digest = await crypto.subtle.digest("SHA-256", raw);
            const bodySha256 = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
            result = { ...result, bodySha256, outcome: "INVALID_RESPONSE" };
            const data = normalizeProbePayload(request, JSON.parse(new TextDecoder().decode(raw)), closedAt);
            result = { ...result, data, outcome: "OK" };
          } else await response.body?.cancel().catch(() => undefined);
        } catch {
          result = { ...result, outcome: response?.ok === true ? "INVALID_RESPONSE" : "NETWORK_ERROR" };
        }
      }
      result = { ...result, completedAt: now() };
      observations.push(result);
      actor.send({ type: "RESULT", provider: request.provider, status: result.status });
    }
    return { protocol: "market-source-probe-v1", runId: crypto.randomUUID(), location: "cloudflare-workers",
      startedAt, completedAt: now(), closedAt, phase: actor.getSnapshot().value, plannedRequests: 15,
      observations, comparison: compareLatestCloses(observations) };
  } finally { actor.stop(); }
};
