export const DASHBOARD_PERP_PNL_MAX_ORDERS = 50;
export const DASHBOARD_PERP_PNL_DEFAULT_LIMIT = 30;
const DASHBOARD_PERP_PNL_MIN_LIMIT = 1;

/**
 * Fait de fill perp lu côté venue (userFills filtré par cloid). Type
 * fermé : aucune adresse, aucun hash, aucune signature. Source de
 * vérité : models/hyperliquid-fill-persistence.md §2.2.
 */
export interface PerpFillFact {
  /** Identifiant technique du trade côté venue (tid). */
  readonly fillId: string;
  readonly side: "BUY" | "SELL";
  readonly price: number;
  readonly quantity: number;
  /** Frais du fill, fact séparé du PnL réalisé. */
  readonly fee: number;
  /** PnL réalisé autoritaire de la venue pour ce fill (peut être négatif). */
  readonly closedPnl: number;
  readonly fillTime: number;
}

export type DashboardPerpPnlErrorCode =
  | "INVALID_LIMIT"
  | "INVALID_PERP_ORDER_ROW"
  | "INVALID_PERP_INTENT_JSON"
  | "INVALID_PERP_FILL_ROW"
  | "INVALID_PERP_FILL_JSON";

export type DashboardPerpPnlResult =
  | { readonly ok: true; readonly value: DashboardPerpPnlHistory }
  | {
      readonly ok: false;
      readonly error: { readonly code: DashboardPerpPnlErrorCode };
    };

/** Ligne de `dodash_perp_orders` retenue par la fenêtre SQL (§4). */
export interface DashboardPerpOrderRow {
  readonly clientOrderId: string;
  readonly intentJson: string;
  readonly outcome: string | null;
  readonly settledAt: number | null;
}

/** Ligne de `dodash_perp_fills` jointe par `client_order_id` (§4). */
export interface DashboardPerpFillRow {
  readonly clientOrderId: string;
  readonly fillJson: string;
}

export interface DashboardPerpFill {
  readonly clientOrderId: string;
  /** Identifiant technique du trade côté venue (tid). */
  readonly fillId: string;
  readonly productId: string;
  readonly side: "BUY" | "SELL";
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
  /** `closedPnl − fee` : le frais nette le fait de venue (§4). */
  readonly realizedPnl: number;
  readonly fillTime: number;
}

export interface DashboardPerpPnlHistory {
  /** Fills de la fenêtre, plus récent d'abord. */
  readonly fills: readonly DashboardPerpFill[];
  /** Somme chronologique des `realizedPnl` de la fenêtre. */
  readonly totalRealizedPnl: number;
  /** Somme chronologique des frais de la fenêtre. */
  readonly totalFee: number;
}

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (code: DashboardPerpPnlErrorCode): DashboardPerpPnlResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({ code }),
  });

/**
 * Forme seule d'un fait de fill (frontière d'écriture du store) : un
 * fill hors domaine est rejeté, jamais écrit ni corrigé.
 */
export const isWellFormedPerpFillFact = (fill: PerpFillFact): boolean =>
  isNonEmptyText(fill.fillId) &&
  (fill.side === "BUY" || fill.side === "SELL") &&
  isPositiveFinite(fill.price) &&
  isPositiveFinite(fill.quantity) &&
  isNonNegativeFinite(fill.fee) &&
  isFiniteNumber(fill.closedPnl) &&
  isSafeTime(fill.fillTime);

/**
 * Intention perp persistée revalidée pour la projection : seuls les
 * champs fermés du type PerpOrderIntent sont acceptés.
 */
const parseIntentProductId = (raw: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (
    !isNonEmptyText(parsed.productId) ||
    (parsed.side !== "BUY" && parsed.side !== "SELL") ||
    !isPositiveFinite(parsed.quantity) ||
    !isPositiveFinite(parsed.markPrice) ||
    !Number.isSafeInteger(parsed.leverage) ||
    (parsed.leverage as number) < 1
  ) {
    return null;
  }
  return parsed.productId;
};

const parsePerpFillRow = (row: DashboardPerpFillRow): DashboardPerpPnlErrorCode | null => {
  if (!isNonEmptyText(row.clientOrderId) || typeof row.fillJson !== "string") {
    return "INVALID_PERP_FILL_ROW";
  }
  return null;
};

const parsePerpOrderRow = (
  row: DashboardPerpOrderRow,
): DashboardPerpPnlErrorCode | null => {
  if (
    !isNonEmptyText(row.clientOrderId) ||
    typeof row.intentJson !== "string" ||
    !(
      row.outcome === null ||
      row.outcome === "ACCEPTED" ||
      row.outcome === "REJECTED"
    ) ||
    !(row.settledAt === null || isSafeTime(row.settledAt))
  ) {
    return "INVALID_PERP_ORDER_ROW";
  }
  return null;
};

const parseFillFactJson = (raw: string): PerpFillFact | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const fact: PerpFillFact = {
    fillId: parsed.fillId as string,
    side: parsed.side as "BUY" | "SELL",
    price: parsed.price as number,
    quantity: parsed.quantity as number,
    fee: parsed.fee as number,
    closedPnl: parsed.closedPnl as number,
    fillTime: parsed.fillTime as number,
  };
  return isWellFormedPerpFillFact(fact) ? fact : null;
};

const compareFillsChronological = (
  left: DashboardPerpFill,
  right: DashboardPerpFill,
): number =>
  left.fillTime - right.fillTime ||
  left.fillId.localeCompare(right.fillId) ||
  left.clientOrderId.localeCompare(right.clientOrderId);

/**
 * Projection PnL perp réalisé du dashboard : fonction pure, fail-closed,
 * lecture-seule. Source normative :
 * models/hyperliquid-fill-persistence.md §4.
 */
export const projectDashboardPerpPnlHistory = (
  orderRows: readonly DashboardPerpOrderRow[],
  fillRows: readonly DashboardPerpFillRow[],
  limit: number,
): DashboardPerpPnlResult => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < DASHBOARD_PERP_PNL_MIN_LIMIT ||
    limit > DASHBOARD_PERP_PNL_MAX_ORDERS ||
    orderRows.length > limit
  ) {
    return failure("INVALID_LIMIT");
  }

  const productIdByOrder = new Map<string, string>();
  for (const row of orderRows) {
    const invalid = parsePerpOrderRow(row);
    if (invalid !== null) return failure(invalid);
    const productId = parseIntentProductId(row.intentJson);
    if (productId === null) return failure("INVALID_PERP_INTENT_JSON");
    productIdByOrder.set(row.clientOrderId, productId);
  }

  const fills: DashboardPerpFill[] = [];
  for (const row of fillRows) {
    const invalid = parsePerpFillRow(row);
    if (invalid !== null) return failure(invalid);
    // Un fill dont l'ordre est hors fenêtre est ignoré (§4).
    const productId = productIdByOrder.get(row.clientOrderId);
    if (productId === undefined) continue;
    const fact = parseFillFactJson(row.fillJson);
    if (fact === null) return failure("INVALID_PERP_FILL_JSON");
    fills.push({
      clientOrderId: row.clientOrderId,
      fillId: fact.fillId,
      productId,
      side: fact.side,
      price: fact.price,
      quantity: fact.quantity,
      fee: fact.fee,
      realizedPnl: fact.closedPnl - fact.fee,
      fillTime: fact.fillTime,
    });
  }

  const chronological = [...fills].sort(compareFillsChronological);
  let totalRealizedPnl = 0;
  let totalFee = 0;
  for (const fill of chronological) {
    totalRealizedPnl += fill.realizedPnl;
    totalFee += fill.fee;
  }

  const mostRecentFirst = chronological.reverse();

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      fills: Object.freeze(mostRecentFirst),
      totalRealizedPnl,
      totalFee,
    }),
  });
};
