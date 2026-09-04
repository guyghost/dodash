import { err, ok, type OrderIntent, type Result } from "@dodash/domain";

import {
  checkRisk,
  type RiskConfig,
  type RiskError,
  type RiskReasonCode,
  type RiskSnapshot,
} from "./risk.js";

/**
 * Garde-fous consolidés du portefeuille multi-produits
 * (models/multi-product-portfolio.md §6). Fonction pure : aucune I/O,
 * aucune horloge globale (C3). Plafonds à deux étages :
 *  - par produit : `checkRisk` existant, sémantique inchangée ;
 *  - consolidé : `maxGrossExposure` (INV-P1) et `maxDailyLoss` (INV-P2)
 *    du portefeuille.
 *
 * Les limites sont structurellement identiques à
 * `PortfolioRiskLimits` de models/multi-product-portfolio.machine.ts ;
 * le verrou de compilation sera posé au branchement runtime (§9), qui
 * importe les deux packages.
 */

export interface PortfolioRiskLimits {
  readonly maxGrossExposure: number;
  readonly maxDailyLoss: number;
}

export interface PortfolioProductRiskInput {
  readonly productId: string;
  readonly intent: OrderIntent | null;
  readonly snapshot: RiskSnapshot;
  readonly config: RiskConfig;
}

export type PortfolioRejectionReasonCode =
  | "CONSOLIDATED_DAILY_LOSS_LIMIT"
  | "CONSOLIDATED_GROSS_EXPOSURE_LIMIT";

export type PortfolioProductDecision =
  | {
      readonly status: "APPROVED";
      readonly stopLossPrice: number;
      readonly takeProfitPrice: number;
      readonly projectedPositionNotional: number;
      readonly projectedGrossExposure: number;
    }
  | {
      readonly status: "REJECTED";
      readonly reasonCode: RiskReasonCode | PortfolioRejectionReasonCode;
    }
  | { readonly status: "NO_ORDER" };

export interface PortfolioProductRiskOutcome {
  readonly productId: string;
  readonly decision: PortfolioProductDecision;
}

export interface PortfolioRiskEvaluation {
  readonly decisions: readonly PortfolioProductRiskOutcome[];
  readonly consolidatedGrossExposure: number;
  readonly consolidatedDailyPnl: number;
}

export type PortfolioRiskError =
  | RiskError
  | { readonly code: "INVALID_PORTFOLIO_LIMITS" }
  | { readonly code: "DUPLICATE_PORTFOLIO_PRODUCT"; readonly productId: string };

const validLimits = (limits: PortfolioRiskLimits): boolean =>
  Number.isFinite(limits.maxGrossExposure) &&
  limits.maxGrossExposure > 0 &&
  Number.isFinite(limits.maxDailyLoss) &&
  limits.maxDailyLoss > 0;

const currentNotional = (input: PortfolioProductRiskInput): number =>
  Math.abs(input.snapshot.currentPositionQuantity) * input.snapshot.marketPrice;

/**
 * Admission consolidée, déterministe (INV-P4) : produits triés par
 * identifiant ; un rejet local d'un produit n'affecte jamais les autres
 * (INV-P3) ; une perte quotidienne consolidée atteinte rejette tous les
 * produits (INV-P2) ; un ordre n'est admis que si le total projeté
 * consolidé reste ≤ au plafond, une réduction d'exposition restant
 * toujours évaluée (INV-P1).
 */
export const evaluatePortfolioRisk = (
  products: readonly PortfolioProductRiskInput[],
  limits: PortfolioRiskLimits,
): Result<PortfolioRiskEvaluation, PortfolioRiskError> => {
  if (!validLimits(limits)) return err({ code: "INVALID_PORTFOLIO_LIMITS" });

  const sorted = [...products].sort((left, right) =>
    left.productId < right.productId
      ? -1
      : left.productId > right.productId
        ? 1
        : 0,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.productId === current.productId
    ) {
      return err({
        code: "DUPLICATE_PORTFOLIO_PRODUCT",
        productId: current.productId,
      });
    }
  }

  const consolidatedDailyPnl = sorted.reduce(
    (total, input) => total + input.snapshot.dailyPnl,
    0,
  );
  if (consolidatedDailyPnl <= -limits.maxDailyLoss) {
    return ok({
      decisions: sorted.map((input) => ({
        productId: input.productId,
        decision: {
          status: "REJECTED" as const,
          reasonCode: "CONSOLIDATED_DAILY_LOSS_LIMIT" as const,
        },
      })),
      consolidatedGrossExposure: sorted.reduce(
        (total, input) => total + currentNotional(input),
        0,
      ),
      consolidatedDailyPnl,
    });
  }

  // INV-P4 : le total démarre au socle (positions courantes de tous les
  // produits) ; une ordre approuvé remplace le socle du produit par sa
  // projection (+= delta) ; un rejet conserve le socle (INV-P1).
  let runningGross = sorted.reduce(
    (total, input) => total + currentNotional(input),
    0,
  );
  const decisions: PortfolioProductRiskOutcome[] = [];
  for (const input of sorted) {
    const baseline = currentNotional(input);
    if (input.intent === null) {
      decisions.push({ productId: input.productId, decision: { status: "NO_ORDER" } });
      continue;
    }
    const risk = checkRisk(input.intent, input.snapshot, input.config);
    if (!risk.ok) return err(risk.error);
    if (risk.value.status === "REJECTED") {
      decisions.push({
        productId: input.productId,
        decision: {
          status: "REJECTED" as const,
          reasonCode: risk.value.reasonCode,
        },
      });
      continue;
    }
    const delta =
      risk.value.projectedPositionNotional - baseline;
    if (runningGross + delta > limits.maxGrossExposure) {
      decisions.push({
        productId: input.productId,
        decision: {
          status: "REJECTED" as const,
          reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT" as const,
        },
      });
      continue;
    }
    runningGross += delta;
    decisions.push({
      productId: input.productId,
      decision: {
        status: "APPROVED" as const,
        stopLossPrice: risk.value.stopLossPrice,
        takeProfitPrice: risk.value.takeProfitPrice,
        projectedPositionNotional: risk.value.projectedPositionNotional,
        projectedGrossExposure: risk.value.projectedGrossExposure,
      },
    });
  }

  return ok({
    decisions,
    consolidatedGrossExposure: runningGross,
    consolidatedDailyPnl,
  });
};
