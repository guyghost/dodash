import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqlitePerpOrderStore,
  loadPerpPnlProjectionRows,
  type PerpOrderSqlAdapter,
} from "../src/hyperliquid-store.js";
import type { PerpFillFact, PerpOrderIntent } from "@dodash/models";

const INTENT: PerpOrderIntent = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

/** Adaptateur réel sur node:sqlite : le SQL exécuté est le SQL testé. */
const createAdapter = (): PerpOrderSqlAdapter & { readonly close: () => void } => {
  const database = new DatabaseSync(":memory:");
  return {
    run: (query, params) => {
      database.prepare(query).run(...(params as never[]));
    },
    all: <T>(query: string, params: readonly unknown[]): readonly T[] =>
      database.prepare(query).all(...(params as never[])) as T[],
    close: () => database.close(),
  };
};

const databases: Array<ReturnType<typeof createAdapter>> = [];
const freshAdapter = (): PerpOrderSqlAdapter => {
  const adapter = createAdapter();
  databases.push(adapter);
  return adapter;
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("createSqlitePerpOrderStore", () => {
  it("persiste et relit une intention non résolue", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const pending = await store.loadUnresolvedOrderIntents();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.clientOrderId).toBe("perp-00000001");
    expect(pending[0]?.intent).toEqual(INTENT);
  });

  it("ne réécrit jamais une intention déjà persistée", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: { ...INTENT, quantity: 9 },
      createdAt: 1_756_416_000_001,
    });

    const pending = await store.loadUnresolvedOrderIntents();
    expect(pending[0]?.intent).toEqual(INTENT);
  });

  it("retire du non résolu une intention dont l'issue est écrite", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    await store.persistOutcome("perp-00000001", "ACCEPTED", 1_756_416_000_500);
    expect(await store.loadUnresolvedOrderIntents()).toEqual([]);
  });

  it("n'écrit l'issue qu'une seule fois (réconciliation idempotente)", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    await store.persistOutcome("perp-00000001", "ACCEPTED", 1_756_416_000_500);
    await store.persistOutcome("perp-00000001", "REJECTED", 1_756_416_000_600);

    const rows = adapter.all<{ outcome: string; settled_at: number }>(
      "SELECT outcome, settled_at FROM dodash_perp_orders",
      [],
    );
    expect(rows).toEqual([{ outcome: "ACCEPTED", settled_at: 1_756_416_000_500 }]);
  });

  it("ordonne les intentions non résolues de la plus récente à la plus ancienne", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    for (const [index, createdAt] of [1_000, 2_000, 3_000].entries()) {
      await store.persistOrderIntent({
        clientOrderId: `perp-0000000${index + 1}`,
        intent: INTENT,
        createdAt,
      });
    }
    const pending = await store.loadUnresolvedOrderIntents();
    expect(pending.map((record) => record.clientOrderId)).toEqual([
      "perp-00000003",
      "perp-00000002",
      "perp-00000001",
    ]);
  });

  it("ignore une intention persistée au JSON illisible", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    adapter.run(
      "UPDATE dodash_perp_orders SET intent_json = ? WHERE client_order_id = ?",
      ["{broken", "perp-00000001"],
    );

    expect(await store.loadUnresolvedOrderIntents()).toEqual([]);
  });
});

const FILL: PerpFillFact = Object.freeze({
  fillId: "441994346001",
  side: "BUY",
  price: 100_050,
  quantity: 0.003,
  fee: 0.15,
  closedPnl: 0,
  fillTime: 1_756_416_000_500,
});

describe("persistance des fills perp (dao #31)", () => {
  it("persiste et relit les fills d'un ordre", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    await store.persistOutcome("perp-00000001", "ACCEPTED", 1_756_416_000_600);
    await store.persistFills("perp-00000001", [FILL], 1_756_416_000_550);

    const rows = loadPerpPnlProjectionRows(adapter, 30);
    expect(rows.orders).toEqual([
      {
        clientOrderId: "perp-00000001",
        intentJson: JSON.stringify(INTENT),
        outcome: "ACCEPTED",
        settledAt: 1_756_416_000_600,
      },
    ]);
    expect(rows.fills).toEqual([
      { clientOrderId: "perp-00000001", fillJson: JSON.stringify(FILL) },
    ]);
  });

  it("ne duplique jamais un fill re-persisté (idempotence)", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistFills("perp-00000001", [FILL], 1_756_416_000_550);
    await store.persistFills("perp-00000001", [FILL], 1_756_416_000_550);

    const rows = adapter.all<{ fill_id: string }>(
      "SELECT fill_id FROM dodash_perp_fills",
      [],
    );
    expect(rows).toEqual([{ fill_id: FILL.fillId }]);
  });

  it("rejette un lot contenant un fill mal formé sans écriture partielle", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    const invalid = { ...FILL, price: 0, fillId: "441994346002" };
    expect(() =>
      store.persistFills("perp-00000001", [FILL, invalid], 1_756_416_000_550),
    ).rejects.toThrow("INVALID_PERP_FILL_FACT");

    const rows = adapter.all<{ fill_id: string }>(
      "SELECT fill_id FROM dodash_perp_fills",
      [],
    );
    expect(rows).toEqual([]);
  });

  it("laisse les lignes préexistantes de dodash_perp_orders intactes", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });
    await store.persistOutcome("perp-00000001", "REJECTED", 1_756_416_000_600);
    const before = adapter.all<unknown>(
      "SELECT * FROM dodash_perp_orders",
      [],
    );

    await store.persistFills("perp-00000001", [FILL], 1_756_416_000_550);
    loadPerpPnlProjectionRows(adapter, 30);

    const after = adapter.all<unknown>("SELECT * FROM dodash_perp_orders", []);
    expect(after).toEqual(before);
  });

  it("borne la fenêtre de projection aux ordres résolus les plus récents", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    for (const index of [1, 2, 3]) {
      await store.persistOrderIntent({
        clientOrderId: `perp-0000000${index}`,
        intent: INTENT,
        createdAt: 1_756_416_000_000 + index,
      });
      await store.persistOutcome(
        `perp-0000000${index}`,
        "ACCEPTED",
        1_756_416_000_000 + index * 100,
      );
      await store.persistFills(`perp-0000000${index}`, [FILL], 1);
    }

    const rows = loadPerpPnlProjectionRows(adapter, 2);
    expect(rows.orders.map((row) => row.clientOrderId)).toEqual([
      "perp-00000003",
      "perp-00000002",
    ]);
    // Les fills de l'ordre hors fenêtre ne sont jamais retournés.
    expect(
      rows.fills.every(
        (row) =>
          row.clientOrderId === "perp-00000002" ||
          row.clientOrderId === "perp-00000003",
      ),
    ).toBe(true);
  });

  it("n'expose qu'une fenêtre vide quand aucun ordre n'est résolu", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_416_000_000,
    });

    const rows = loadPerpPnlProjectionRows(adapter, 30);
    expect(rows.orders).toEqual([]);
    expect(rows.fills).toEqual([]);
  });

  it("refuse un limit hors bornes (fail-closed)", () => {
    const adapter = freshAdapter();
    expect(() => loadPerpPnlProjectionRows(adapter, 0)).toThrow();
    expect(() => loadPerpPnlProjectionRows(adapter, 51)).toThrow();
    expect(() => loadPerpPnlProjectionRows(adapter, 1.5)).toThrow();
  });
});

describe("détection des créneaux de rattrapage (dao #33)", () => {
  it("détecte les ordres ACCEPTED sans fill, du plus récemment réglé au plus ancien", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    // ancien comblé : jamais un créneau
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_415_000_000,
    });
    await store.persistOutcome("perp-00000001", "ACCEPTED", 1_756_415_000_600);
    await store.persistFills("perp-00000001", [FILL], 1_756_415_000_550);
    // rejeté sans fill : jamais un créneau
    await store.persistOrderIntent({
      clientOrderId: "perp-00000002",
      intent: INTENT,
      createdAt: 1_756_415_100_000,
    });
    await store.persistOutcome("perp-00000002", "REJECTED", 1_756_415_100_600);
    // non résolu : jamais un créneau
    await store.persistOrderIntent({
      clientOrderId: "perp-00000003",
      intent: INTENT,
      createdAt: 1_756_415_200_000,
    });
    // deux créneaux : le plus récemment réglé d'abord
    await store.persistOrderIntent({
      clientOrderId: "perp-00000004",
      intent: INTENT,
      createdAt: 1_756_415_300_000,
    });
    await store.persistOutcome("perp-00000004", "ACCEPTED", 1_756_415_300_600);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000005",
      intent: INTENT,
      createdAt: 1_756_415_400_000,
    });
    await store.persistOutcome("perp-00000005", "ACCEPTED", 1_756_415_400_600);

    const gaps = await store.loadAcceptedOrderIdsMissingFills(10);
    expect(gaps).toEqual(["perp-00000005", "perp-00000004"]);
  });

  it("départage déterministement les créneaux réglés au même instant", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    for (const clientOrderId of ["perp-00000009", "perp-00000010"]) {
      await store.persistOrderIntent({
        clientOrderId,
        intent: INTENT,
        createdAt: 1_756_415_000_000,
      });
      await store.persistOutcome(
        clientOrderId,
        "ACCEPTED",
        1_756_415_000_600,
      );
    }
    const gaps = await store.loadAcceptedOrderIdsMissingFills(10);
    expect(gaps).toEqual(["perp-00000010", "perp-00000009"]);
  });

  it("sort un créneau de la détection une fois comblé, sans doublon", async () => {
    const adapter = freshAdapter();
    const store = createSqlitePerpOrderStore(adapter);
    await store.persistOrderIntent({
      clientOrderId: "perp-00000001",
      intent: INTENT,
      createdAt: 1_756_415_000_000,
    });
    await store.persistOutcome("perp-00000001", "ACCEPTED", 1_756_415_000_600);
    expect(await store.loadAcceptedOrderIdsMissingFills(10)).toEqual([
      "perp-00000001",
    ]);

    await store.persistFills("perp-00000001", [FILL], 1_756_415_000_550);
    await store.persistFills("perp-00000001", [FILL], 1_756_415_000_550);
    expect(await store.loadAcceptedOrderIdsMissingFills(10)).toEqual([]);
    const rows = adapter.all<{ fill_id: string }>(
      "SELECT fill_id FROM dodash_perp_fills",
      [],
    );
    expect(rows).toEqual([{ fill_id: FILL.fillId }]);
  });

  it("refuse une limite hors domaine (fail-closed)", async () => {
    const store = createSqlitePerpOrderStore(freshAdapter());
    await expect(
      store.loadAcceptedOrderIdsMissingFills(0),
    ).rejects.toThrow("INVALID_PERP_FILL_BACKFILL_LIMIT");
    await expect(
      store.loadAcceptedOrderIdsMissingFills(1.5),
    ).rejects.toThrow("INVALID_PERP_FILL_BACKFILL_LIMIT");
  });
});
