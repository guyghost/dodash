export const DASHBOARD_PNL_HISTORY_MAX_CYCLES = 50;
export const DASHBOARD_PNL_HISTORY_DEFAULT_LIMIT = 30;
const DASHBOARD_PNL_HISTORY_MIN_LIMIT = 1;

export type DashboardPnlHistoryErrorCode =
  | "INVALID_LIMIT"
  | "INVALID_CYCLE_ROW"
  | "INVALID_ARTIFACTS_JSON"
  | "INVALID_ORDER_ROW"
  | "INVALID_EXECUTION_JSON";

export type DashboardPnlHistoryResult =
  | { readonly ok: true; readonly value: DashboardPnlHistory }
  | {
      readonly ok: false;
      readonly error: { readonly code: DashboardPnlHistoryErrorCode };
    };

/** Ligne de `dodash_cycles` retenue par la fenêtre SQL (models/dashboard-pnl-history.md §2). */
export interface DashboardPnlCycleRow {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number | null;
  readonly outcome: string;
  readonly artifactsJson: string;
}

/** Ligne de `dodash_orders` jointe par `cycle_id` (models/dashboard-pnl-history.md §2). */
export interface DashboardPnlOrderRow {
  readonly clientOrderId: string;
  readonly cycleId: string;
  readonly status: string;
  readonly executionJson: string | null;
}

export interface DashboardPnlEquityPoint {
  readonly t: number;
  readonly equity: number;
}

export interface DashboardPnlCycleHistory {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number | null;
  readonly outcome: string;
  readonly marketPrice: number | null;
  readonly side: "BUY" | "SELL" | null;
  readonly quantity: number | null;
  readonly fillPrice: number | null;
  readonly fee: number | null;
  readonly realizedPnl: number | null;
  readonly slippageBps: number | null;
}

export interface DashboardPnlProtection {
  readonly stopLossPrice: number;
  readonly takeProfitPrice: number;
  readonly protectiveOrderConfirmed: boolean;
}

export interface DashboardPnlHistory {
  /** Points d'équité par `triggered_at` croissant. */
  readonly equityCurve: readonly DashboardPnlEquityPoint[];
  /** Cycles de la fenêtre, plus récent d'abord. */
  readonly cycles: readonly DashboardPnlCycleHistory[];
  readonly openPosition:
    | { readonly quantity: number; readonly averagePrice: number }
    | null;
  readonly protection: DashboardPnlProtection | null;
}

interface PortfolioFacts {
  readonly cash: number;
  readonly positionQuantity: number;
  readonly averagePrice: number;
}

interface FillFacts {
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
}

type SubmissionFacts =
  | {
      readonly kind: "trade";
      readonly status: "CONFIRMED" | "PROTECTION_FAILED";
      readonly portfolio: PortfolioFacts;
      readonly fill: FillFacts | null;
      readonly protectiveOrderConfirmed: boolean;
    }
  | { readonly kind: "portfolio-only"; readonly portfolio: PortfolioFacts }
  | { readonly kind: "none" };

interface ArtifactsFacts {
  readonly marketPrice: number | null;
  readonly side: "BUY" | "SELL" | null;
  readonly quantity: number | null;
  readonly stopLossPrice: number | null;
  readonly takeProfitPrice: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const failure = (code: DashboardPnlHistoryErrorCode): DashboardPnlHistoryResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({ code }),
  });

const parsePortfolio = (value: unknown): PortfolioFacts | null => {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.cash) ||
    !isFiniteNumber(value.positionQuantity) ||
    !isNonNegativeFinite(value.averagePrice)
  ) {
    return null;
  }
  return {
    cash: value.cash,
    positionQuantity: value.positionQuantity,
    averagePrice: value.averagePrice,
  };
};

const parseFill = (value: unknown): FillFacts | null => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isPositiveFinite(value.price) ||
    !isPositiveFinite(value.quantity) ||
    !isNonNegativeFinite(value.fee)
  ) {
    return null;
  }
  return { price: value.price, quantity: value.quantity, fee: value.fee };
};

/**
 * Portefeuille porté : seuls CONFIRMED, PROTECTION_FAILED et
 * NO_SELL_NEEDED font foi (models/dashboard-pnl-history.md §3.2).
 */
const parseSubmission = (raw: string): SubmissionFacts | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const status = parsed.status;
  if (status === "REJECTED" || status === "TERMINAL_FAILED") {
    return { kind: "none" };
  }
  if (
    status !== "CONFIRMED" &&
    status !== "PROTECTION_FAILED" &&
    status !== "NO_SELL_NEEDED"
  ) {
    return null;
  }
  const portfolio = parsePortfolio(parsed.portfolio);
  if (portfolio === null) return null;
  if (status === "NO_SELL_NEEDED") {
    return { kind: "portfolio-only", portfolio };
  }
  const fill = parseFill(parsed.fill);
  if (parsed.fill !== null && fill === null) return null;
  const protectiveOrderId = parsed.protectiveOrderId;
  return {
    kind: "trade",
    status,
    portfolio,
    fill,
    protectiveOrderConfirmed:
      typeof protectiveOrderId === "string" && protectiveOrderId.length > 0,
  };
};

/** Champs du cycle extraits d'artifacts_json (models/dashboard-pnl-history.md §2). */
const parseArtifacts = (raw: string): ArtifactsFacts | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  let marketPrice: number | null = null;
  if (parsed.market !== undefined) {
    if (!isRecord(parsed.market) || !Array.isArray(parsed.market.candles)) {
      return null;
    }
    const last = parsed.market.candles.at(-1);
    if (last !== undefined) {
      if (!isRecord(last) || !isPositiveFinite(last.close)) return null;
      marketPrice = last.close;
    }
  }

  let side: "BUY" | "SELL" | null = null;
  let quantity: number | null = null;
  if (parsed.order !== undefined) {
    if (
      !isRecord(parsed.order) ||
      (parsed.order.side !== "BUY" && parsed.order.side !== "SELL") ||
      !isPositiveFinite(parsed.order.quantity)
    ) {
      return null;
    }
    side = parsed.order.side;
    quantity = parsed.order.quantity;
  }

  let stopLossPrice: number | null = null;
  let takeProfitPrice: number | null = null;
  if (parsed.risk !== undefined) {
    if (!isRecord(parsed.risk)) return null;
    if (parsed.risk.status === "APPROVED") {
      if (
        !isPositiveFinite(parsed.risk.stopLossPrice) ||
        !isPositiveFinite(parsed.risk.takeProfitPrice)
      ) {
        return null;
      }
      stopLossPrice = parsed.risk.stopLossPrice;
      takeProfitPrice = parsed.risk.takeProfitPrice;
    } else if (parsed.risk.status !== "REJECTED") {
      return null;
    }
  }

  return { marketPrice, side, quantity, stopLossPrice, takeProfitPrice };
};

const parseCycleRow = (
  row: DashboardPnlCycleRow,
): DashboardPnlHistoryErrorCode | null => {
  if (
    !isNonEmptyText(row.cycleId) ||
    !isSafeTime(row.triggeredAt) ||
    !(row.completedAt === null || isSafeTime(row.completedAt)) ||
    !isNonEmptyText(row.outcome) ||
    typeof row.artifactsJson !== "string"
  ) {
    return "INVALID_CYCLE_ROW";
  }
  return null;
};

const parseOrderRow = (
  row: DashboardPnlOrderRow,
): DashboardPnlHistoryErrorCode | null => {
  if (
    !isNonEmptyText(row.clientOrderId) ||
    !isNonEmptyText(row.cycleId) ||
    !isNonEmptyText(row.status) ||
    !(row.executionJson === null || typeof row.executionJson === "string")
  ) {
    return "INVALID_ORDER_ROW";
  }
  return null;
};

const compareCycles = (
  left: DashboardPnlCycleRow,
  right: DashboardPnlCycleRow,
): number =>
  left.triggeredAt - right.triggeredAt ||
  left.cycleId.localeCompare(right.cycleId);

const byClientOrderId = (
  left: DashboardPnlOrderRow,
  right: DashboardPnlOrderRow,
): number => left.clientOrderId.localeCompare(right.clientOrderId);

/**
 * Projection PnL/équité du dashboard : fonction pure, fail-closed.
 * Source normative : models/dashboard-pnl-history.md §3.
 */
export const projectDashboardPnlHistory = (
  cycleRows: readonly DashboardPnlCycleRow[],
  orderRows: readonly DashboardPnlOrderRow[],
  limit: number,
): DashboardPnlHistoryResult => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < DASHBOARD_PNL_HISTORY_MIN_LIMIT ||
    limit > DASHBOARD_PNL_HISTORY_MAX_CYCLES ||
    cycleRows.length > limit
  ) {
    return failure("INVALID_LIMIT");
  }

  const ordersByCycle = new Map<string, DashboardPnlOrderRow[]>();
  for (const row of orderRows) {
    const invalid = parseOrderRow(row);
    if (invalid !== null) return failure(invalid);
    const bucket = ordersByCycle.get(row.cycleId);
    if (bucket === undefined) {
      ordersByCycle.set(row.cycleId, [row]);
    } else {
      bucket.push(row);
    }
  }
  for (const bucket of ordersByCycle.values()) {
    bucket.sort(byClientOrderId);
  }

  let carriedPortfolio: PortfolioFacts | null = null;
  let protectionCandidate: DashboardPnlProtection | null = null;
  const equityCurve: DashboardPnlEquityPoint[] = [];
  const cyclesAscending: DashboardPnlCycleHistory[] = [];

  for (const cycleRow of [...cycleRows].sort(compareCycles)) {
    const invalidCycle = parseCycleRow(cycleRow);
    if (invalidCycle !== null) return failure(invalidCycle);
    const artifacts = parseArtifacts(cycleRow.artifactsJson);
    if (artifacts === null) return failure("INVALID_ARTIFACTS_JSON");

    const previousPortfolio = carriedPortfolio;
    let trade:
      | {
          readonly side: "BUY" | "SELL";
          readonly quantity: number;
          readonly fillPrice: number;
          readonly fee: number;
        }
      | null = null;

    for (const orderRow of ordersByCycle.get(cycleRow.cycleId) ?? []) {
      if (orderRow.executionJson === null) continue;
      const submission = parseSubmission(orderRow.executionJson);
      if (submission === null) return failure("INVALID_EXECUTION_JSON");
      if (submission.kind === "none") continue;
      // §3.2 : chaque soumission porteuse met à jour le portefeuille porté.
      carriedPortfolio = submission.portfolio;
      // §3.2 : le premier ordre porteur d'un fill confirme le trade du
      // cycle. Un PROTECTION_FAILED portant un fill est structurellement
      // une sortie de vente (§3.3), même sans intention persistée.
      if (
        trade === null &&
        submission.kind === "trade" &&
        submission.fill !== null
      ) {
        const side =
          artifacts.side ??
          (submission.status === "PROTECTION_FAILED" ? "SELL" : null);
        if (side !== null) {
          trade = {
            side,
            quantity: submission.fill.quantity,
            fillPrice: submission.fill.price,
            fee: submission.fill.fee,
          };
        }
      }
      if (
        submission.kind === "trade" &&
        artifacts.side === "BUY" &&
        artifacts.stopLossPrice !== null &&
        artifacts.takeProfitPrice !== null
      ) {
        protectionCandidate = {
          stopLossPrice: artifacts.stopLossPrice,
          takeProfitPrice: artifacts.takeProfitPrice,
          protectiveOrderConfirmed: submission.protectiveOrderConfirmed,
        };
      }
    }

    let realizedPnl: number | null = null;
    let slippageBps: number | null = null;
    if (trade !== null) {
      if (
        previousPortfolio !== null &&
        trade.side === "SELL" &&
        previousPortfolio.positionQuantity > 0
      ) {
        const closedQuantity = Math.min(
          previousPortfolio.positionQuantity,
          trade.quantity,
        );
        realizedPnl =
          (trade.fillPrice - previousPortfolio.averagePrice) * closedQuantity -
          trade.fee;
      }
      if (artifacts.marketPrice !== null) {
        const direction = trade.side === "SELL" ? -1 : 1;
        slippageBps =
          ((trade.fillPrice - artifacts.marketPrice) / artifacts.marketPrice) *
          10_000 *
          direction;
      }
    }

    if (carriedPortfolio !== null && artifacts.marketPrice !== null) {
      equityCurve.push({
        t: cycleRow.triggeredAt,
        equity:
          carriedPortfolio.cash +
          carriedPortfolio.positionQuantity * artifacts.marketPrice,
      });
    }

    cyclesAscending.push({
      cycleId: cycleRow.cycleId,
      triggeredAt: cycleRow.triggeredAt,
      completedAt: cycleRow.completedAt,
      outcome: cycleRow.outcome,
      marketPrice: artifacts.marketPrice,
      side: trade?.side ?? null,
      quantity: trade?.quantity ?? null,
      fillPrice: trade?.fillPrice ?? null,
      fee: trade?.fee ?? null,
      realizedPnl,
      slippageBps,
    });
  }

  const openPosition =
    carriedPortfolio !== null && carriedPortfolio.positionQuantity > 0
      ? {
          quantity: carriedPortfolio.positionQuantity,
          averagePrice: carriedPortfolio.averagePrice,
        }
      : null;

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      equityCurve: Object.freeze(equityCurve),
      cycles: Object.freeze(cyclesAscending.reverse()),
      openPosition: openPosition === null ? null : Object.freeze(openPosition),
      protection:
        openPosition === null ? null : protectionCandidate,
    }),
  });
};
