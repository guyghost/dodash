import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqlitePerpOrderStore,
  type PerpOrderSqlAdapter,
} from "../src/hyperliquid-store.js";
import type { PerpOrderIntent } from "@dodash/models";

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
