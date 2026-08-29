import { describe, expect, it, vi } from "vitest";

import {
  createHyperliquidPerpRunner,
  createInMemoryPerpOrderStore,
  type HyperliquidPerpRunner,
  type PerpOrderStore,
} from "../src/hyperliquid-orchestrator.js";
import type { HyperliquidRequestDependencies } from "../src/hyperliquid-execution.js";
import type { HyperliquidExecutionSettings } from "../src/hyperliquid-settings.js";
import type { PerpOrderIntent, PerpRiskGate } from "@dodash/models";

const settings: HyperliquidExecutionSettings = {
  apiBaseUrl: "https://api.hyperliquid.test",
  agentPrivateKey:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  walletAddress: "0x2222222222222222222222222222222222222222",
  isTestnet: false,
};

const INTENT: PerpOrderIntent = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

const GATE: PerpRiskGate = Object.freeze({
  admissionApproved: true,
  positionQuantity: 0,
  dailyPnl: 0,
  otherGrossExposureNotional: 0,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Harness {
  readonly runner: HyperliquidPerpRunner;
  readonly store: PerpOrderStore;
  readonly fetchMock: ReturnType<
    typeof vi.fn<(url: unknown, init?: unknown) => Promise<Response>>
  >;
}

const createHarness = (
  responses: ReadonlyArray<Response> = [
    jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
    jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
  ],
): Harness => {
  const store = createInMemoryPerpOrderStore();
  const queue = [...responses];
  const fetchMock = vi.fn(async (
    _url: unknown,
    _init?: unknown,
  ): Promise<Response> => {
    const next = (queue.length > 1 ? queue.shift() : queue[0]) as Response;
    return next;
  });
  const dependencies: HyperliquidRequestDependencies = {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => 1_756_416_000_000,
  };
  const runner = createHyperliquidPerpRunner({
    settings,
    store,
    dependencies,
  });
  return { runner, store, fetchMock };
};

describe("createHyperliquidPerpRunner", () => {
  it("refuse hors admission avant tout événement de machine", async () => {
    const { runner } = createHarness();
    const result = await runner.runOrder({
      intent: { ...INTENT, productId: "SOL-PERP" },
      gate: GATE,
      clientOrderId: "perp-00000001",
    });
    expect(result).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_ADMISSION_REQUIRED",
    });
  });

  it("laisse la garde de la machine refuser une intention hors enveloppe", async () => {
    const { runner } = createHarness();
    const result = await runner.runOrder({
      intent: INTENT,
      gate: { ...GATE, dailyPnl: -1_000 },
      clientOrderId: "perp-00000001",
    });
    expect(result).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_DAILY_LOSS_BREACHED",
    });
  });

  it("persiste l'intention avant signature, puis soumet et settle", async () => {
    const { runner, store, fetchMock } = createHarness();
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000001",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000001",
    });
    expect(await store.loadUnresolvedOrderIntents()).toEqual([]);

    const exchangeCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url).endsWith("/exchange"),
    );
    expect(exchangeCalls).toHaveLength(1);
  });

  it("ne signe ni ne soumet lorsque la méta ne connaît pas le marché", async () => {
    const { runner, fetchMock } = createHarness([
      jsonResponse({ universe: [{ name: "DOGE", szDecimals: 2, maxLeverage: 10 }] }),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000001",
    });
    expect(result).toEqual({ status: "FAILED", error: { code: "SIGN_FAILED" } });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/exchange")),
    ).toHaveLength(0);
  });

  it("conserve l'intention non résolue quand la soumission est inconnue", async () => {
    const { runner, store } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      new Response("gateway timeout", { status: 504 }),
      jsonResponse({
        status: "ok",
        data: { status: { status: "filled" } },
      }),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000002",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000002",
    });
    expect(await store.loadUnresolvedOrderIntents()).toEqual([]);
  });

  it("échoue fermé quand la réconciliation ne résout pas", async () => {
    const { runner, store } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      new Response("gateway timeout", { status: 504 }),
      new Response("gateway timeout", { status: 504 }),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000003",
    });
    expect(result).toEqual({
      status: "FAILED",
      error: { code: "RECONCILIATION_FAILED" },
    });
    const unresolved = await store.loadUnresolvedOrderIntents();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.clientOrderId).toBe("perp-00000003");
  });

  it("reprend une intention en vol par la réconciliation uniquement", async () => {
    const { runner, store, fetchMock } = createHarness([
      jsonResponse({ status: "ok", data: { status: { status: "filled" } } }),
    ]);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000004",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const report = await runner.recoverPending();
    expect(report).toEqual({ recovered: 1, unresolved: 0 });
    expect(await store.loadUnresolvedOrderIntents()).toEqual([]);

    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.every((url) => url.endsWith("/info"))).toBe(true);
    expect(requestedUrls.some((url) => url.endsWith("/exchange"))).toBe(false);
  });

  it("laisse non résolue une intention dont la réconciliation échoue", async () => {
    const { runner, store } = createHarness([
      new Response("gateway timeout", { status: 504 }),
    ]);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000005",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const report = await runner.recoverPending();
    expect(report).toEqual({ recovered: 0, unresolved: 1 });
    expect(await store.loadUnresolvedOrderIntents()).toHaveLength(1);
  });

  it("expose un résultat sans clé ni signature", async () => {
    const { runner } = createHarness();
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000006",
    });
    expect(JSON.stringify(result)).not.toContain("privateKey");
    expect(JSON.stringify(result)).not.toContain("agentPrivateKey");
    expect(JSON.stringify(result)).not.toContain("signature");
  });
});
