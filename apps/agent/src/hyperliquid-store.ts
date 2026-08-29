import type {
  HyperliquidOrderOutcome,
  PerpOrderIntent,
} from "@dodash/models";

import type { PerpOrderRecord, PerpOrderStore } from "./hyperliquid-orchestrator.js";

/**
 * Adaptateur SQL minimal pour le store d'ordres perp. Le Durable Object
 * l'implémente sur `sql.exec` ; les tests l'implémentent sur SQLite réel
 * (node:sqlite). Source de vérité : models/hyperliquid-orchestration.md.
 */
export interface PerpOrderSqlAdapter {
  run(query: string, params: readonly unknown[]): void;
  all<T>(query: string, params: readonly unknown[]): readonly T[];
}

export const PERP_ORDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dodash_perp_orders (
    client_order_id TEXT PRIMARY KEY,
    intent_json TEXT NOT NULL,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  )
`;

export const ensurePerpOrderSchema = (adapter: PerpOrderSqlAdapter): void => {
  adapter.run(PERP_ORDERS_SCHEMA, []);
};

interface PerpOrderRow {
  readonly client_order_id: string;
  readonly intent_json: string;
}

export const createSqlitePerpOrderStore = (
  adapter: PerpOrderSqlAdapter,
): PerpOrderStore =>
  Object.freeze({
    async persistOrderIntent(record: PerpOrderRecord) {
      ensurePerpOrderSchema(adapter);
      // Idempotent : un clientOrderId déjà persisté n'est jamais écrasé.
      adapter.run(
        `INSERT OR IGNORE INTO dodash_perp_orders
           (client_order_id, intent_json, outcome, created_at, settled_at)
         VALUES (?, ?, NULL, ?, NULL)`,
        [
          record.clientOrderId,
          JSON.stringify(record.intent),
          record.createdAt,
        ],
      );
    },
    async persistOutcome(
      clientOrderId: string,
      outcome: HyperliquidOrderOutcome,
      settledAt: number,
    ) {
      ensurePerpOrderSchema(adapter);
      // L'issue n'est écrite qu'une fois : la réconciliation est idempotente.
      adapter.run(
        `UPDATE dodash_perp_orders
           SET outcome = ?, settled_at = ?
         WHERE client_order_id = ? AND outcome IS NULL`,
        [outcome, settledAt, clientOrderId],
      );
    },
    async loadUnresolvedOrderIntents(): Promise<readonly PerpOrderRecord[]> {
      ensurePerpOrderSchema(adapter);
      const rows = adapter.all<PerpOrderRow>(
        `SELECT client_order_id, intent_json
           FROM dodash_perp_orders
          WHERE outcome IS NULL
          ORDER BY created_at DESC`,
        [],
      );
      const records: PerpOrderRecord[] = [];
      for (const row of rows) {
        let intent: PerpOrderIntent | null = null;
        try {
          intent = JSON.parse(row.intent_json) as PerpOrderIntent;
        } catch {
          intent = null;
        }
        if (intent !== null) {
          records.push({
            clientOrderId: row.client_order_id,
            intent,
            createdAt: 0,
          });
        }
      }
      return Object.freeze(records);
    },
  });
