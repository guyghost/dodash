import {
  isWellFormedPerpFillFact,
  type DashboardPerpFillRow,
  type DashboardPerpOrderRow,
  type HyperliquidOrderOutcome,
  type PerpFillFact,
  type PerpOrderIntent,
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

/**
 * Table dédiée des fills perp (dao #31) : migration strictement
 * additive (CREATE TABLE IF NOT EXISTS, pas de DROP, pas d'ALTER sur
 * les tables existantes) — les lignes préexistantes de
 * `dodash_perp_orders` ne sont jamais touchées. Source de vérité :
 * models/hyperliquid-fill-persistence.md §3.
 */
export const PERP_FILLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dodash_perp_fills (
    client_order_id TEXT NOT NULL,
    fill_id TEXT NOT NULL,
    fill_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_order_id, fill_id)
  )
`;

export const ensurePerpOrderSchema = (adapter: PerpOrderSqlAdapter): void => {
  adapter.run(PERP_ORDERS_SCHEMA, []);
  adapter.run(PERP_FILLS_SCHEMA, []);
};

interface PerpOrderRow {
  readonly client_order_id: string;
  readonly intent_json: string;
}

export const DASHBOARD_PERP_PNL_MAX_ORDERS = 50;
export const DASHBOARD_PERP_PNL_DEFAULT_LIMIT = 30;

export interface PerpPnlProjectionRows {
  readonly orders: readonly DashboardPerpOrderRow[];
  readonly fills: readonly DashboardPerpFillRow[];
}

interface PerpOrderStatusRow {
  readonly client_order_id: string;
  readonly intent_json: string;
  readonly outcome: string | null;
  readonly settled_at: number | null;
}

interface PerpFillIdRow {
  readonly client_order_id: string;
  readonly fill_json: string;
}

/**
 * Lecture bornée des lignes de projection PnL perp (dao #31) : les N
 * ordres perp résolus les plus récents et les fills de ces ordres.
 * Lecture-seule, LIMIT uniquement ; un limit hors [1, 50] est refusé
 * (fail-closed). Source de vérité :
 * models/hyperliquid-fill-persistence.md §4.
 */
export const loadPerpPnlProjectionRows = (
  adapter: PerpOrderSqlAdapter,
  limit: number,
): PerpPnlProjectionRows => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > DASHBOARD_PERP_PNL_MAX_ORDERS
  ) {
    throw new Error("INVALID_PERP_PNL_LIMIT");
  }
  ensurePerpOrderSchema(adapter);
  const orders = adapter
    .all<PerpOrderStatusRow>(
      `SELECT client_order_id, intent_json, outcome, settled_at
         FROM dodash_perp_orders
        WHERE outcome IS NOT NULL
        ORDER BY settled_at DESC, client_order_id DESC
        LIMIT ?`,
      [limit],
    )
    .map(
      (row): DashboardPerpOrderRow => ({
        clientOrderId: row.client_order_id,
        intentJson: row.intent_json,
        outcome: row.outcome,
        settledAt: row.settled_at,
      }),
    );
  const orderIds = orders.map((row) => row.clientOrderId);
  const fills =
    orderIds.length === 0
      ? []
      : adapter
          .all<PerpFillIdRow>(
            `SELECT client_order_id, fill_json
               FROM dodash_perp_fills
              WHERE client_order_id IN (${orderIds.map(() => "?").join(", ")})
              ORDER BY client_order_id ASC, fill_id ASC`,
            orderIds,
          )
          .map(
            (row): DashboardPerpFillRow => ({
              clientOrderId: row.client_order_id,
              fillJson: row.fill_json,
            }),
          );
  return Object.freeze({ orders: Object.freeze(orders), fills: Object.freeze(fills) });
};

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
    async loadAcceptedOrderIdsMissingFills(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("INVALID_PERP_FILL_BACKFILL_LIMIT");
      }
      ensurePerpOrderSchema(adapter);
      // Détection lecture-seule des créneaux (dao #33, §2.5) : ordres
      // résolus ACCEPTED sans aucune ligne de fill, le plus récemment
      // réglé d'abord (départage déterministe par identifiant). Aucune
      // écriture, aucune table ni colonne nouvelle.
      return Object.freeze(
        adapter
          .all<{ readonly client_order_id: string }>(
            `SELECT o.client_order_id
               FROM dodash_perp_orders AS o
              WHERE o.outcome = 'ACCEPTED'
                AND NOT EXISTS (
                  SELECT 1 FROM dodash_perp_fills AS f
                   WHERE f.client_order_id = o.client_order_id
                )
              ORDER BY o.settled_at DESC, o.client_order_id DESC
              LIMIT ?`,
            [limit],
          )
          .map((row) => row.client_order_id),
      );
    },
    async persistFills(
      clientOrderId: string,
      fills: readonly PerpFillFact[],
      persistedAt: number,
    ) {
      ensurePerpOrderSchema(adapter);
      // Frontière fail-closed : chaque fill est validé AVANT toute
      // écriture — un lot contenant un fill hors domaine est rejeté en
      // échec typé, sans écriture partielle (models/
      // hyperliquid-fill-persistence.md §3). L'écriture est idempotente
      // : re-réconcilier ne duplique jamais un fill.
      for (const fill of fills) {
        if (!isWellFormedPerpFillFact(fill)) {
          throw new Error("INVALID_PERP_FILL_FACT");
        }
      }
      for (const fill of fills) {
        adapter.run(
          `INSERT OR IGNORE INTO dodash_perp_fills
             (client_order_id, fill_id, fill_json, created_at)
           VALUES (?, ?, ?, ?)`,
          [clientOrderId, fill.fillId, JSON.stringify(fill), persistedAt],
        );
      }
    },
  });
