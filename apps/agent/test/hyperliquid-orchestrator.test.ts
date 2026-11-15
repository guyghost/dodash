import { describe, expect, it, vi } from "vitest";

import {
  createHyperliquidPerpRunner,
  createInMemoryPerpOrderStore,
  PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE,
  type HyperliquidPerpRunner,
  type PerpOrderStore,
} from "../src/hyperliquid-orchestrator.js";
import type { HyperliquidRequestDependencies } from "../src/hyperliquid-execution.js";
import { hyperliquidCloidFromClientOrderId } from "../src/hyperliquid-signing.js";
import type { HyperliquidExecutionSettings } from "../src/hyperliquid-settings.js";
import type { PerpFillFact, PerpOrderIntent, PerpRiskGate } from "@dodash/models";

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
  readonly persistedFills: ReadonlyArray<{
    readonly clientOrderId: string;
    readonly fills: readonly PerpFillFact[];
  }>;
}

/** Store d'enregistrement : base mémoire + traces de persistFills. */
const recordingStore = (base: PerpOrderStore) => {
  const persistedFills: Array<{
    readonly clientOrderId: string;
    readonly fills: readonly PerpFillFact[];
  }> = [];
  const store: PerpOrderStore = {
    ...base,
    async persistFills(clientOrderId, fills, persistedAt) {
      persistedFills.push({ clientOrderId, fills });
      await base.persistFills(clientOrderId, fills, persistedAt);
    },
  };
  return { store, persistedFills };
};

const bodiesOf = (
  fetchMock: Harness["fetchMock"],
): ReadonlyArray<Record<string, unknown>> =>
  fetchMock.mock.calls.map(([url, init]) => {
    void String(url);
    return JSON.parse(String((init as { body?: unknown })?.body)) as Record<
      string,
      unknown
    >;
  });

const createHarness = (
  responses: ReadonlyArray<Response> = [
    jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
    jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
    // Lecture userFills (dao #31) : aucun fill par défaut.
    jsonResponse([]),
  ],
  baseStore: PerpOrderStore = createInMemoryPerpOrderStore(),
): Harness => {
  const { store, persistedFills } = recordingStore(baseStore);
  const queue = [...responses];
  const fetchMock = vi.fn(async (
    _url: unknown,
    _init?: unknown,
  ): Promise<Response> => {
    const next = (queue.length > 1 ? queue.shift() : queue[0]) as Response;
    // Corps frais à chaque appel : une Response ne se consomme qu'une
    // fois, et le rattrapage (dao #33) relit la même réponse venue.
    return next.clone();
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
  return { runner, store, fetchMock, persistedFills };
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
      fillPersistenceFailures: 0,
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
      jsonResponse([]),
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
      fillPersistenceFailures: 0,
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
      jsonResponse([]),
    ]);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000004",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const report = await runner.recoverPending();
    expect(report).toEqual({
      recovered: 1,
      unresolved: 0,
      fillPersistenceFailures: 0,
      // L'ordre réconcilié n'a aucun fill (lecture []): il devient un
      // créneau du rattrapage borné, re-relu sans ligne inventée.
      fillBackfillFilled: 0,
      fillBackfillFailures: 0,
      fillBackfillUnresolved: 1,
      fillBackfillTruncated: false,
    });
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
    expect(report).toEqual({
      recovered: 0,
      unresolved: 1,
      fillPersistenceFailures: 0,
      fillBackfillFilled: 0,
      fillBackfillFailures: 0,
      fillBackfillUnresolved: 0,
      fillBackfillTruncated: false,
    });
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

describe("persistance des fills réconciliés (dao #31)", () => {
  const CLOID = hyperliquidCloidFromClientOrderId("perp-00000007");

  const venueFill = (overrides: Record<string, unknown> = {}) => ({
    coin: "BTC",
    px: "100050.0",
    sz: "0.003",
    side: "B",
    time: 1_756_416_000_500,
    startPosition: 0,
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0xabc",
    oid: 308427057,
    crossed: true,
    fee: "0.15",
    tid: 441994346001,
    cloid: CLOID,
    ...overrides,
  });

  it("persiste les fills d'un ordre accepté au fil de l'eau, avant l'issue", async () => {
    const { runner, persistedFills, fetchMock } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
      jsonResponse([venueFill()]),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000007",
      fillPersistenceFailures: 0,
    });
    expect(persistedFills).toEqual([
      {
        clientOrderId: "perp-00000007",
        fills: [
          {
            fillId: "441994346001",
            side: "BUY",
            price: 100_050,
            quantity: 0.003,
            fee: 0.15,
            closedPnl: 0,
            fillTime: 1_756_416_000_500,
          },
        ],
      },
    ]);
    const fillsCall = bodiesOf(fetchMock).find((body) => body.type === "userFills");
    expect(fillsCall).toEqual({ type: "userFills", user: settings.walletAddress });
  });

  it("persiste un fill partiel tel quel — jamais complété ni estimé", async () => {
    const { runner, persistedFills } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
      jsonResponse([venueFill({ sz: "0.002" })]),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result.status).toBe("SETTLED");
    expect(persistedFills[0]?.fills).toEqual([
      {
        fillId: "441994346001",
        side: "BUY",
        price: 100_050,
        quantity: 0.002,
        fee: 0.15,
        closedPnl: 0,
        fillTime: 1_756_416_000_500,
      },
    ]);
  });

  it("n'invente aucune ligne en l'absence de fill", async () => {
    const { runner, persistedFills } = createHarness();
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000007",
      fillPersistenceFailures: 0,
    });
    expect(persistedFills).toEqual([]);
  });

  it("ignore les fills sans notre cloid — ordres placés hors du bot", async () => {
    const { runner, persistedFills } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
      jsonResponse([
        venueFill({ cloid: `0x${"9".repeat(32)}` }),
        venueFill({ cloid: undefined }),
      ]),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result.status).toBe("SETTLED");
    expect(persistedFills).toEqual([]);
  });

  it("compte une lecture indisponible sans jamais échouer le cycle (C3)", async () => {
    const { runner, persistedFills } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
      new Response("gateway timeout", { status: 504 }),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    // L'issue reste prioritaire : fills absents, cycle settles quand même.
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000007",
      fillPersistenceFailures: 1,
    });
    expect(persistedFills).toEqual([]);
  });

  it("compte un échec d'écriture des fills sans jamais échouer le cycle (C3)", async () => {
    const base = createInMemoryPerpOrderStore();
    const failingStore: PerpOrderStore = {
      ...base,
      persistFills: async () => {
        throw new Error("disk full");
      },
    };
    const { runner, persistedFills } = createHarness(
      [
        jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
        jsonResponse({ status: "ok", response: { data: { statuses: [{ resting: { oid: 1 } }] } } }),
        jsonResponse([venueFill()]),
      ],
      failingStore,
    );
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "ACCEPTED",
      clientOrderId: "perp-00000007",
      fillPersistenceFailures: 1,
    });
    expect(persistedFills).toHaveLength(1);
  });

  it("ne lit aucun fill pour une issue rejetée", async () => {
    const { runner, persistedFills, fetchMock } = createHarness([
      jsonResponse({ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }),
      jsonResponse({
        status: "ok",
        response: { data: { statuses: [{ error: "Order was never placed" }] } },
      }),
    ]);
    const result = await runner.runOrder({
      intent: INTENT,
      gate: GATE,
      clientOrderId: "perp-00000007",
    });
    expect(result).toEqual({
      status: "SETTLED",
      outcome: "REJECTED",
      clientOrderId: "perp-00000007",
      fillPersistenceFailures: 0,
    });
    expect(persistedFills).toEqual([]);
    expect(
      bodiesOf(fetchMock).some((body) => body.type === "userFills"),
    ).toBe(false);
  });

  it("persiste les fills lors de la reprise après crash, même port", async () => {
    const { runner, store, persistedFills } = createHarness([
      jsonResponse({ status: "ok", data: { status: { status: "filled" } } }),
      jsonResponse([venueFill({ sz: "0.005", closedPnl: "12.5" })]),
    ]);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000007",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    const report = await runner.recoverPending();
    expect(report).toEqual({
      recovered: 1,
      unresolved: 0,
      fillPersistenceFailures: 0,
      fillBackfillFilled: 0,
      fillBackfillFailures: 0,
      fillBackfillUnresolved: 0,
      fillBackfillTruncated: false,
    });
    expect(persistedFills[0]?.clientOrderId).toBe("perp-00000007");
    expect(persistedFills[0]?.fills[0]?.closedPnl).toBe(12.5);
  });
});

describe("rattrapage borné des fills manqués (dao #33)", () => {
  const venueFill = (clientOrderId: string, overrides: Record<string, unknown> = {}) => ({
    coin: "BTC",
    px: "100050.0",
    sz: "0.003",
    side: "B",
    time: 1_756_416_000_500,
    startPosition: 0,
    dir: "Open Long",
    closedPnl: "0.0",
    hash: "0xabc",
    oid: 308427057,
    crossed: true,
    fee: "0.15",
    tid: 441994346001,
    cloid: hyperliquidCloidFromClientOrderId(clientOrderId),
    ...overrides,
  });

  const seedAcceptedOrder = async (
    store: PerpOrderStore,
    clientOrderId: string,
    settledAt: number,
  ): Promise<void> => {
    await store.persistOrderIntent({
      clientOrderId,
      intent: INTENT,
      createdAt: settledAt - 1_000,
    });
    await store.persistOutcome(clientOrderId, "ACCEPTED", settledAt);
  };

  it("comble un créneau détecté avec les fills de la venue, sans le re-relu ensuite", async () => {
    const { runner, store, persistedFills, fetchMock } = createHarness([
      jsonResponse([venueFill("perp-00000021", { sz: "0.005", closedPnl: "3.5" })]),
    ]);
    await seedAcceptedOrder(store, "perp-00000021", 1_756_416_000_000);

    const report = await runner.recoverPending();
    expect(report).toEqual({
      recovered: 0,
      unresolved: 0,
      fillPersistenceFailures: 0,
      fillBackfillFilled: 1,
      fillBackfillFailures: 0,
      fillBackfillUnresolved: 0,
      fillBackfillTruncated: false,
    });
    expect(persistedFills).toEqual([
      {
        clientOrderId: "perp-00000021",
        fills: [
          {
            fillId: "441994346001",
            side: "BUY",
            price: 100_050,
            quantity: 0.005,
            fee: 0.15,
            closedPnl: 3.5,
            fillTime: 1_756_416_000_500,
          },
        ],
      },
    ]);

    // Le créneau comblé sort de la détection : aucun nouvel appel venue.
    const callsAfterFirstCycle = fetchMock.mock.calls.length;
    const second = await runner.recoverPending();
    expect(second.fillBackfillFilled).toBe(0);
    expect(second.fillBackfillUnresolved).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstCycle);
  });

  it("n'invente aucune ligne quand la venue ne connaît pas le fill", async () => {
    const { runner, store, persistedFills } = createHarness([jsonResponse([])]);
    await seedAcceptedOrder(store, "perp-00000021", 1_756_416_000_000);

    const report = await runner.recoverPending();
    expect(report.fillBackfillFilled).toBe(0);
    expect(report.fillBackfillUnresolved).toBe(1);
    expect(report.fillBackfillFailures).toBe(0);
    expect(report.fillBackfillTruncated).toBe(false);
    expect(persistedFills).toEqual([]);
  });

  it("respecte le plafond par cycle et reporte le reste au cycle suivant", async () => {
    const cap = PERP_FILL_BACKFILL_MAX_GAPS_PER_CYCLE;
    const { runner, store, fetchMock } = createHarness([jsonResponse([])]);
    for (let index = 1; index <= cap + 2; index += 1) {
      await seedAcceptedOrder(
        store,
        `perp-${String(index).padStart(8, "0")}`,
        1_756_416_000_000 + index,
      );
    }

    const first = await runner.recoverPending();
    expect(first.fillBackfillTruncated).toBe(true);
    expect(first.fillBackfillUnresolved).toBe(cap);
    expect(first.fillBackfillFailures).toBe(0);
    expect(first.fillBackfillFilled).toBe(0);
    const callsAfterFirstCycle = fetchMock.mock.calls.length;
    expect(callsAfterFirstCycle).toBe(cap);

    // Rattrapage partiel : les créneaux vides restent en tête de
    // détection (ils ne sortent que comblés) — le tail de 2 créneaux
    // plus anciens est reporté, jamais servi tant que la tête n'est pas
    // comblée : exactement cap nouvelles lectures venue, pas une de plus.
    const second = await runner.recoverPending();
    expect(second.fillBackfillTruncated).toBe(true);
    expect(second.fillBackfillUnresolved).toBe(cap);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstCycle + cap);
  });

  it("ne réécrit jamais un ordre ayant déjà un fill — seul le créneau est relu", async () => {
    const existingFill: PerpFillFact = Object.freeze({
      fillId: "441994346000",
      side: "BUY",
      price: 100_000,
      quantity: 0.005,
      fee: 0.15,
      closedPnl: 0,
      fillTime: 1_756_416_000_400,
    });
    const { runner, store, persistedFills, fetchMock } = createHarness([
      jsonResponse([venueFill("perp-00000022")]),
    ]);
    await seedAcceptedOrder(store, "perp-00000021", 1_756_416_000_000);
    await store.persistFills("perp-00000021", [existingFill], 1_756_416_000_100);
    await seedAcceptedOrder(store, "perp-00000022", 1_756_416_001_000);

    const report = await runner.recoverPending();
    expect(report.fillBackfillFilled).toBe(1);
    expect(report.fillBackfillUnresolved).toBe(0);
    const fillCalls = bodiesOf(fetchMock).filter(
      (body) => body.type === "userFills",
    );
    expect(fillCalls).toHaveLength(1);
    expect(fillCalls[0]?.user).toBe(settings.walletAddress);
    // L'ordre déjà comblé : exactement l'écriture de setup, jamais une
    // réécriture par le rattrapage.
    expect(
      persistedFills.filter((entry) => entry.clientOrderId === "perp-00000021"),
    ).toHaveLength(1);
    expect(
      persistedFills.filter((entry) => entry.clientOrderId === "perp-00000022"),
    ).toHaveLength(1);
  });

  it("compte un échec de lecture venue sans jamais échouer la reprise (C3)", async () => {
    const { runner, store } = createHarness([
      new Response("gateway timeout", { status: 504 }),
    ]);
    await seedAcceptedOrder(store, "perp-00000021", 1_756_416_000_000);

    const report = await runner.recoverPending();
    expect(report).toEqual({
      recovered: 0,
      unresolved: 0,
      fillPersistenceFailures: 1,
      fillBackfillFilled: 0,
      fillBackfillFailures: 1,
      fillBackfillUnresolved: 1,
      fillBackfillTruncated: false,
    });
  });

  it("annule le rattrapage sans toucher aux ordres en vol si la détection échoue", async () => {
    const base = createInMemoryPerpOrderStore();
    const brokenDetection: PerpOrderStore = {
      ...base,
      loadAcceptedOrderIdsMissingFills: async () => {
        throw new Error("sqlite locked");
      },
    };
    const { runner, store } = createHarness(
      [
        jsonResponse({ status: "ok", data: { status: { status: "filled" } } }),
        jsonResponse([venueFill("perp-00000007")]),
      ],
      brokenDetection,
    );
    await store.persistOrderIntent({
      clientOrderId: "perp-00000007",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const report = await runner.recoverPending();
    expect(report).toEqual({
      recovered: 1,
      unresolved: 0,
      fillPersistenceFailures: 0,
      fillBackfillFilled: 0,
      fillBackfillFailures: 1,
      fillBackfillUnresolved: 0,
      fillBackfillTruncated: false,
    });
  });
});
