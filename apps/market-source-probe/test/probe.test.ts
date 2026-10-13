import { describe, expect, it, vi } from "vitest";
import worker, { type ProbeEnv } from "../src/index.js";
import { runMarketProbe } from "../src/run.js";
import { normalizeProbePayload } from "../src/normalize.js";
import { CANDLE_LIMIT, DAY, planProbeRequests } from "../src/plan.js";

const NOW = Date.UTC(2026, 9, 13, 23);
const env: ProbeEnv = { DIAGNOSTIC_TOKEN: "diagnostic-test-token-with-more-than-32-chars", PROBE_ENABLED: "true", PROBE_STARTED_AT: String(NOW), PROBE_EXPIRES_AT: String(NOW + DAY) };
const input = { enabled: true, startedAt: NOW, expiresAt: NOW + DAY, requestCount: 15 };
const payload = () => ({ candles: Array.from({ length: CANDLE_LIMIT }, (_, i) => ({ start: (Math.floor(NOW / DAY) * DAY - (CANDLE_LIMIT - i) * DAY) / 1000, open: 10, high: 11, low: 9, close: 10, volume: 1 })) });

describe("source diagnostics", () => {
  it("accepts a runtime empty POST stream without accepting content", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    try {
      const request = new Request("https://probe/probe", { method: "POST", headers: { authorization: `Bearer ${env.DIAGNOSTIC_TOKEN}` },
        body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: "half" } as RequestInit);
      expect(request.body).not.toBeNull();
      expect((await worker.fetch(request, env)).status).toBe(200);
    } finally { clock.mockRestore(); fetch.mockRestore(); }
  });
  it("rejects unauthenticated, malformed and inactive requests without any upstream call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      expect((await worker.fetch(new Request("https://probe/probe", { method: "POST" }), env)).status).toBe(401);
      const headers = { authorization: `Bearer ${env.DIAGNOSTIC_TOKEN}` };
      expect((await worker.fetch(new Request("https://probe/probe?url=https://evil", { method: "POST", headers }), env)).status).toBe(400);
      expect((await worker.fetch(new Request("https://probe/probe", { method: "POST", headers, body: "{}" }), env)).status).toBe(400);
      expect((await worker.fetch(new Request("https://probe/probe", { method: "POST", headers }), {})).status).toBe(401);
      expect((await worker.fetch(new Request("https://probe/probe", { method: "POST", headers }), { ...env, PROBE_ENABLED: "false" })).status).toBe(410);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); clock.mockRestore(); }
  });
  it("requires the Bearer scheme, not a bare token", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    try {
      expect((await worker.fetch(new Request("https://probe/probe", { method: "POST", headers: { authorization: env.DIAGNOSTIC_TOKEN! } }), env)).status).toBe(401);
    } finally { clock.mockRestore(); fetch.mockRestore(); }
  });
  it("blocks remaining provider calls after 429, records skips and never retries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 429, headers: { "retry-after": "120" } }));
    const report = await runMarketProbe(input, { fetch, now: () => NOW });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(report.observations).toHaveLength(15);
    expect(report.observations.filter((r) => r.outcome === "SKIPPED_RATE_LIMIT")).toHaveLength(11);
    expect(report.phase).toBe("completed");
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === "manual" && !new Headers(init?.headers).has("authorization"))).toBe(true);
  });
  it("does not probe before activation or after expiry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const report = await runMarketProbe({ ...input, expiresAt: NOW }, { fetch, now: () => NOW });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.phase).toBe("inactive");
  });
  it("stops starting requests when the first call crosses expiry", async () => {
    let time = NOW;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { time = NOW + DAY; return new Response("", { status: 503 }); });
    const report = await runMarketProbe(input, { fetch, now: () => time });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report.phase).toBe("inactive");
  });
  it("preserves the platform fetch receiver", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError("illegal invocation");
      return new Response("", { status: 503 });
    });
    const report = await runMarketProbe(input, { fetch, now: () => NOW });
    expect(report.observations.every((r) => r.status === 503)).toBe(true);
  });
  it("aborts a stalled call at the batch deadline without retrying", async () => {
    let time = NOW;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { time = NOW + 1; reject(new Error("timeout")); });
    }));
    const report = await runMarketProbe({ ...input, expiresAt: NOW + 1 }, { fetch, now: () => time });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(report.observations[0]?.outcome).toBe("NETWORK_ERROR");
    expect(report.phase).toBe("inactive");
  });
  it("reports broken JSON and oversized bodies without returning raw errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("not JSON with untrusted instructions", { headers: { "content-length": "9999999" } }));
    const report = await runMarketProbe(input, { fetch, now: () => NOW });
    expect(report.observations.every((r) => r.outcome === "INVALID_RESPONSE")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("untrusted instructions");
  });
  it("validates complete daily windows and diagnoses missing/duplicate candles", () => {
    const request = planProbeRequests(NOW)[0]!;
    const json = payload();
    expect(normalizeProbePayload(request, json, Math.floor(NOW / DAY) * DAY)).toMatchObject({ ready: true, closedCount: 240, missingStarts: [] });
    json.candles.pop();
    expect(normalizeProbePayload(request, json, Math.floor(NOW / DAY) * DAY)).toMatchObject({ ready: false, closedCount: 239 });
    json.candles.push(json.candles[0]!);
    expect(normalizeProbePayload(request, json, Math.floor(NOW / DAY) * DAY)).toMatchObject({ ready: false, duplicateStarts: [json.candles[0]!.start * 1000] });
  });
  it("rejects wrong product and wrong granularity instead of mixing sources", () => {
    const request = planProbeRequests(NOW).find((r) => r.provider === "hyperliquid" && r.kind === "candles")!;
    expect(() => normalizeProbePayload(request, [{ t: NOW, o: 1, h: 1, l: 1, c: 1, v: 1, s: "ETH", i: "1d" }], NOW)).toThrow();
    expect(() => normalizeProbePayload(request, [{ t: NOW, o: 1, h: 1, l: 1, c: 1, v: 1, s: "BTC", i: "4h" }], NOW)).toThrow();
  });
});
