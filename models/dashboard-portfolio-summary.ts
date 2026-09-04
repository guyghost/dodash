import type { PortfolioProductStatus } from "./multi-product-portfolio.machine.js";
import { DASHBOARD_REMOTE_PHASES } from "./dashboard-session.types.js";

/**
 * Projection portefeuille du dashboard (dao #32) : fonction pure,
 * fail-closed, du même pattern que projectDashboardPnlHistory (dao #26).
 * Source normative : models/dashboard-portfolio-summary.md §3.
 * Entrée : copie structurelle de l'instantané `portfolioSession` du
 * Durable Object (aucune I/O, aucune reconstruction) ; sortie : agrégat
 * par produit + consolidé, ou échec typé global.
 */

export type DashboardPortfolioErrorCode =
  | "INVALID_PORTFOLIO_SESSION"
  | "INVALID_PRODUCT_FACTS"
  | "INVALID_CONSOLIDATED_LIMITS";

export type DashboardPortfolioSummaryResult =
  | { readonly ok: true; readonly value: DashboardPortfolioSummaryValue }
  | {
      readonly ok: false;
      readonly error: { readonly code: DashboardPortfolioErrorCode };
    };

/** Phases fermées de l'orchestrateur portefeuille (§5 de #24). */
const PORTFOLIO_PHASES: readonly string[] = Object.freeze([
  "validating",
  "rejected",
  "idle",
  "running",
  "draining",
  "complete",
  "halted",
]);

const PRODUCT_STATUSES: readonly PortfolioProductStatus[] = Object.freeze([
  "running",
  "stopped",
  "halted",
  "failed",
]);

const REMOTE_PHASES: readonly string[] = DASHBOARD_REMOTE_PHASES;

export interface DashboardPortfolioLastCycle {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number;
  readonly outcome: string;
  readonly marketPrice: number | null;
}

/** Faits d'un créneau produit (copie du runtime persisté, §3.2 du modèle). */
export interface DashboardPortfolioProductInput {
  readonly productId: string;
  readonly phase: string;
  readonly status: PortfolioProductStatus;
  readonly cash: number;
  readonly positionQuantity: number;
  readonly averagePrice: number;
  readonly dailyPnl: number;
  /** Plafond d'exposition brute du créneau (`slot.risk.maxGrossExposure`). */
  readonly maxGrossExposure: number;
  readonly lastCycle: DashboardPortfolioLastCycle | null;
}

/** Instantané orchestrateur + créneaux (copie de `portfolioSession`). */
export interface DashboardPortfolioSessionInput {
  readonly phase: string;
  readonly killSwitchActive: boolean;
  /** Plafonds consolidés (§7 de #24) ; `null` = absents alors que des produits sont déclarés. */
  readonly portfolioRisk: { readonly maxGrossExposure: number; readonly maxDailyLoss: number } | null;
  readonly products: readonly DashboardPortfolioProductInput[];
}

export interface DashboardPortfolioProductSummary {
  readonly productId: string;
  readonly phase: string;
  readonly status: PortfolioProductStatus;
  readonly cash: number;
  readonly positionQuantity: number;
  readonly averagePrice: number;
  /** Dernier close connu (dernier cycle persisté), `null` si jamais évalué. */
  readonly marketPrice: number | null;
  /** `|positionQuantity| × (marketPrice ?? averagePrice)` — formule `productGrossExposure` (§9.4 de #28). */
  readonly grossExposure: number;
  readonly maxGrossExposure: number;
  readonly dailyPnl: number;
  readonly lastCycle: DashboardPortfolioLastCycle | null;
}

export interface DashboardPortfolioConsolidated {
  readonly grossExposure: number;
  readonly maxGrossExposure: number;
  readonly dailyPnl: number;
  readonly maxDailyLoss: number;
}

export interface DashboardPortfolioSummary {
  readonly kind: "portfolio";
  readonly phase: string;
  readonly killSwitchActive: boolean;
  /** Créneaux triés par `productId` (ordre des points de code, S7). */
  readonly products: readonly DashboardPortfolioProductSummary[];
  readonly consolidated: DashboardPortfolioConsolidated;
}

/**
 * `portfolio` = instance multi-produits ; `single-product` = agent
 * mono-produit classique (backward-compat, §3.1 du modèle).
 */
export type DashboardPortfolioSummaryValue =
  | DashboardPortfolioSummary
  | { readonly kind: "single-product" };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const failure = (code: DashboardPortfolioErrorCode): DashboardPortfolioSummaryResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({ code }),
  });

const validateLastCycle = (
  lastCycle: DashboardPortfolioLastCycle,
): boolean =>
  isNonEmptyText(lastCycle.cycleId) &&
  isSafeTime(lastCycle.triggeredAt) &&
  isSafeTime(lastCycle.completedAt) &&
  isNonEmptyText(lastCycle.outcome) &&
  (lastCycle.marketPrice === null || isPositiveFinite(lastCycle.marketPrice));

const validateProductShape = (
  product: DashboardPortfolioProductInput,
): boolean =>
  isNonEmptyText(product.productId) &&
  REMOTE_PHASES.includes(product.phase) &&
  PRODUCT_STATUSES.includes(product.status);

const validateProductFacts = (
  product: DashboardPortfolioProductInput,
): boolean =>
  isFiniteNumber(product.cash) &&
  isNonNegativeFinite(product.positionQuantity) &&
  isNonNegativeFinite(product.averagePrice) &&
  isFiniteNumber(product.dailyPnl) &&
  isPositiveFinite(product.maxGrossExposure) &&
  (product.lastCycle === null || validateLastCycle(product.lastCycle));

/** S7 : ordre des points de code, indépendant de toute locale. */
const byProductId = (
  left: DashboardPortfolioProductInput,
  right: DashboardPortfolioProductInput,
): number => (left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0);

/**
 * Projection portefeuille du dashboard : fonction pure, fail-closed.
 * Source normative : models/dashboard-portfolio-summary.md §3.
 */
export const projectDashboardPortfolioSummary = (
  session: DashboardPortfolioSessionInput | null,
): DashboardPortfolioSummaryResult => {
  // §3.1 : mono-produit = réponse valide, pas une erreur.
  if (session === null) {
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({ kind: "single-product" }) as DashboardPortfolioSummaryValue,
    });
  }

  if (
    typeof session.killSwitchActive !== "boolean" ||
    !PORTFOLIO_PHASES.includes(session.phase) ||
    !Array.isArray(session.products) ||
    session.products.length === 0 ||
    session.portfolioRisk === null
  ) {
    return failure("INVALID_PORTFOLIO_SESSION");
  }

  const seen = new Set<string>();
  for (const product of session.products) {
    // §3.4 : phase/statut hors ensemble fermé = structure de session
    // incohérente, pas un fait numérique hors domaine.
    if (
      seen.has(product.productId) ||
      !validateProductShape(product)
    ) {
      return failure("INVALID_PORTFOLIO_SESSION");
    }
    seen.add(product.productId);
  }

  const limits = session.portfolioRisk;
  if (
    !isPositiveFinite(limits.maxGrossExposure) ||
    !isPositiveFinite(limits.maxDailyLoss)
  ) {
    return failure("INVALID_CONSOLIDATED_LIMITS");
  }

  const sorted = [...session.products].sort(byProductId);
  for (const product of sorted) {
    if (!validateProductFacts(product)) return failure("INVALID_PRODUCT_FACTS");
  }

  // §3.3 : sommes itérées en ordre trié (l'addition flottante n'est pas
  // associative) — chaque chiffre dérivé des faits produits (S1, S7).
  let consolidatedExposure = 0;
  let consolidatedDailyPnl = 0;
  const products: DashboardPortfolioProductSummary[] = sorted.map((product) => {
    const marketPrice = product.lastCycle?.marketPrice ?? null;
    const grossExposure =
      Math.abs(product.positionQuantity) *
      (marketPrice ?? product.averagePrice);
    consolidatedExposure += grossExposure;
    consolidatedDailyPnl += product.dailyPnl;
    return Object.freeze({
      productId: product.productId,
      phase: product.phase,
      status: product.status,
      cash: product.cash,
      positionQuantity: product.positionQuantity,
      averagePrice: product.averagePrice,
      marketPrice,
      grossExposure,
      maxGrossExposure: product.maxGrossExposure,
      dailyPnl: product.dailyPnl,
      lastCycle: product.lastCycle,
    });
  });

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      kind: "portfolio",
      phase: session.phase,
      killSwitchActive: session.killSwitchActive,
      products: Object.freeze(products),
      consolidated: Object.freeze({
        grossExposure: consolidatedExposure,
        maxGrossExposure: limits.maxGrossExposure,
        dailyPnl: consolidatedDailyPnl,
        maxDailyLoss: limits.maxDailyLoss,
      }),
    }) satisfies DashboardPortfolioSummaryValue as DashboardPortfolioSummaryValue,
  });
};
