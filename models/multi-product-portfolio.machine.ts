import { assign, setup } from "xstate";

/**
 * Modèle normatif du portefeuille multi-produits (models/
 * multi-product-portfolio.md §5). L'orchestrateur du Durable Object :
 * un acteur `tradingCycleMachine` par produit, des rapports d'exposition
 * par effet, et l'admission consolidée des propositions de risque
 * (INV-P1, INV-P2, INV-P3, INV-P4, INV-P5). La machine ne voit ni prix
 * ni ordre — uniquement des notionals d'exposition rapportés.
 */

export interface PortfolioRiskLimits {
  readonly maxGrossExposure: number;
  readonly maxDailyLoss: number;
}

export type PortfolioProductStatus =
  | "running"
  | "stopped"
  | "halted"
  | "failed";

export type PortfolioConsolidatedReasonCode =
  | "CONSOLIDATED_DAILY_LOSS_LIMIT"
  | "CONSOLIDATED_GROSS_EXPOSURE_LIMIT"
  | "CONSOLIDATED_KILL_SWITCH"
  | "UNKNOWN_PRODUCT";

export interface PortfolioRiskDecisionRecord {
  readonly productId: string;
  readonly approved: boolean;
  readonly reasonCode: PortfolioConsolidatedReasonCode | null;
}

export type PortfolioWorkflowErrorCode =
  | "CONTROL_PERMISSION_REQUIRED"
  | "INVALID_PORTFOLIO_INPUT"
  | "UNKNOWN_PRODUCT";

export interface PortfolioWorkflowError {
  readonly code: PortfolioWorkflowErrorCode;
}

export interface MultiProductPortfolioInput {
  readonly products: readonly string[];
  readonly limits: PortfolioRiskLimits;
}

export interface MultiProductPortfolioContext {
  readonly products: readonly string[];
  readonly statuses: Readonly<Record<string, PortfolioProductStatus>>;
  readonly exposure: Readonly<Record<string, number>>;
  readonly dailyPnl: Readonly<Record<string, number>>;
  readonly limits: PortfolioRiskLimits;
  readonly killSwitchActive: boolean;
  readonly lastDecision: PortfolioRiskDecisionRecord | null;
  readonly lastError: PortfolioWorkflowError | null;
}

export type MultiProductPortfolioEvent =
  | { type: "PORTFOLIO_STARTED" }
  | { type: "PRODUCT_STOPPED"; productId: string }
  | { type: "PRODUCT_HALTED"; productId: string }
  | { type: "PRODUCT_FAILED"; productId: string }
  | {
      type: "PRODUCT_EXPOSURE_REPORTED";
      productId: string;
      grossExposure: number;
      dailyPnl: number;
    }
  | { type: "RISK_PROPOSED"; productId: string; proposedGrossExposure: number }
  | { type: "KILL_SWITCH_ENGAGED"; controlId: string }
  | { type: "RESET" };

// INV-P4 : les sommes consolidées itèrent des clés triées — l'addition
// en virgule flottante n'est pas associative, l'ordre fixe garantit le
// déterminisme du rejeu.
const sortedKeys = (
  record: Readonly<Record<string, number>>,
): readonly string[] => Object.keys(record).sort();

const sumOverSorted = (record: Readonly<Record<string, number>>): number =>
  sortedKeys(record).reduce((total, key) => total + (record[key] ?? 0), 0);

const sumWithReplacement = (
  record: Readonly<Record<string, number>>,
  key: string,
  value: number,
): number =>
  sortedKeys(record).reduce(
    (total, current) =>
      total + (current === key ? value : (record[current] ?? 0)),
    0,
  );

const validLimits = (limits: PortfolioRiskLimits): boolean =>
  Number.isFinite(limits.maxGrossExposure) &&
  limits.maxGrossExposure > 0 &&
  Number.isFinite(limits.maxDailyLoss) &&
  limits.maxDailyLoss > 0;

const zeroed = (
  products: readonly string[],
): Readonly<Record<string, number>> =>
  Object.freeze(Object.fromEntries(products.map((product) => [product, 0])));

const runningStatuses = (
  products: readonly string[],
): Readonly<Record<string, PortfolioProductStatus>> =>
  Object.freeze(
    Object.fromEntries(products.map((product) => [product, "running"] as const)),
  );

const productOf = (
  event: MultiProductPortfolioEvent,
): string | null =>
  "productId" in event && typeof event.productId === "string"
    ? event.productId
    : null;

export const multiProductPortfolioMachine = setup({
  types: {
    context: {} as MultiProductPortfolioContext,
    events: {} as MultiProductPortfolioEvent,
    input: {} as MultiProductPortfolioInput,
  },
  guards: {
    // Entrée invalide (doublon, liste vide, limites non positives) :
    // fail-closed, la machine n'est jamais opérable (INV-P5).
    inputValid: ({ context }) =>
      context.products.length > 0 &&
      new Set(context.products).size === context.products.length &&
      validLimits(context.limits),
    productKnown: ({ context, event }) => {
      const productId = productOf(event);
      return (
        productId !== null &&
        Object.prototype.hasOwnProperty.call(context.statuses, productId)
      );
    },
    controlIdPresent: ({ event }) =>
      event.type === "KILL_SWITCH_ENGAGED" && event.controlId.trim().length > 0,
    // Admission consolidée d'une proposition : produit connu et en cours
    // (INV-P3), kill switch inactif, perte quotidienne sous le plafond
    // (INV-P2) et exposition brute consolidée sous le plafond (INV-P1).
    admissible: ({ context, event }) => {
      if (event.type !== "RISK_PROPOSED") return false;
      const known = Object.prototype.hasOwnProperty.call(
        context.statuses,
        event.productId,
      );
      return (
        known &&
        context.statuses[event.productId] === "running" &&
        !context.killSwitchActive &&
        sumOverSorted(context.dailyPnl) > -context.limits.maxDailyLoss &&
        sumWithReplacement(
          context.exposure,
          event.productId,
          event.proposedGrossExposure,
        ) <= context.limits.maxGrossExposure
      );
    },
    // INV-P3 : quiescence — aucun produit pending/running restant.
    portfolioQuiescent: ({ context }) =>
      context.products.every(
        (product) =>
          context.statuses[product] !== "running" &&
          context.statuses[product] !== undefined,
      ),
  },
  actions: {
    initializePortfolio: assign(({ context }) => ({
      statuses: runningStatuses(context.products),
      exposure: zeroed(context.products),
      dailyPnl: zeroed(context.products),
      killSwitchActive: false,
      lastDecision: null,
      lastError: null,
    })),
    markProductStopped: assign(({ context, event }) => {
      const productId = productOf(event);
      if (productId === null) return {};
      return {
        statuses: { ...context.statuses, [productId]: "stopped" },
      };
    }),
    markProductHalted: assign(({ context, event }) => {
      const productId = productOf(event);
      if (productId === null) return {};
      return {
        statuses: { ...context.statuses, [productId]: "halted" },
      };
    }),
    markProductFailed: assign(({ context, event }) => {
      const productId = productOf(event);
      if (productId === null) return {};
      return {
        statuses: { ...context.statuses, [productId]: "failed" },
      };
    }),
    recordExposure: assign(({ context, event }) => {
      if (event.type !== "PRODUCT_EXPOSURE_REPORTED") return {};
      return {
        exposure: { ...context.exposure, [event.productId]: event.grossExposure },
        dailyPnl: { ...context.dailyPnl, [event.productId]: event.dailyPnl },
      };
    }),
    // INV-P5 : la décision consolidée est une garde de cette machine ;
    // l'interpréteur lit `lastDecision` après `send` et n'agit que sur
    // `approved`.
    commitProposal: assign(({ context, event }) => {
      if (event.type !== "RISK_PROPOSED") return {};
      return {
        exposure: {
          ...context.exposure,
          [event.productId]: event.proposedGrossExposure,
        },
        lastDecision: {
          productId: event.productId,
          approved: true,
          reasonCode: null,
        },
      };
    }),
    rejectProposal: assign(({ context, event }) => {
      if (event.type !== "RISK_PROPOSED") return {};
      const known = Object.prototype.hasOwnProperty.call(
        context.statuses,
        event.productId,
      );
      const reasonCode: PortfolioConsolidatedReasonCode = !known
        ? "UNKNOWN_PRODUCT"
        : context.killSwitchActive
          ? "CONSOLIDATED_KILL_SWITCH"
          : sumOverSorted(context.dailyPnl) <= -context.limits.maxDailyLoss
            ? "CONSOLIDATED_DAILY_LOSS_LIMIT"
            : "CONSOLIDATED_GROSS_EXPOSURE_LIMIT";
      return {
        lastDecision: {
          productId: event.productId,
          approved: false,
          reasonCode,
        },
      };
    }),
    requestKillSwitch: assign({ killSwitchActive: true }),
    recordControlDenied: assign({
      lastError: { code: "CONTROL_PERMISSION_REQUIRED" },
    }),
    recordUnknownProduct: assign({
      lastError: { code: "UNKNOWN_PRODUCT" },
    }),
    resetPortfolio: assign(({ context }) => ({
      products: context.products,
      statuses: {},
      exposure: {},
      dailyPnl: {},
      killSwitchActive: false,
      lastDecision: null,
      lastError: null,
    })),
  },
}).createMachine({
  id: "multiProductPortfolio",
  context: ({ input }) => ({
    products: Object.freeze([...input.products].sort()),
    statuses: {},
    exposure: {},
    dailyPnl: {},
    limits: input.limits,
    killSwitchActive: false,
    lastDecision: null,
    lastError: null,
  }),
  initial: "validating",
  states: {
    validating: {
      always: [
        { guard: "inputValid", target: "idle" },
        { target: "rejected" },
      ],
    },
    rejected: {},
    idle: {
      on: {
        PORTFOLIO_STARTED: {
          target: "running",
          actions: "initializePortfolio",
        },
      },
    },
    running: {
      always: { guard: "portfolioQuiescent", target: "complete" },
      on: {
        RISK_PROPOSED: [
          { guard: "admissible", actions: "commitProposal" },
          { actions: "rejectProposal" },
        ],
        PRODUCT_STOPPED: [
          { guard: "productKnown", actions: "markProductStopped" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_HALTED: [
          { guard: "productKnown", actions: "markProductHalted" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_FAILED: [
          { guard: "productKnown", actions: "markProductFailed" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_EXPOSURE_REPORTED: [
          { guard: "productKnown", actions: "recordExposure" },
          { actions: "recordUnknownProduct" },
        ],
        KILL_SWITCH_ENGAGED: [
          {
            guard: "controlIdPresent",
            target: "draining",
            actions: "requestKillSwitch",
          },
          { actions: "recordControlDenied" },
        ],
      },
    },
    draining: {
      always: { guard: "portfolioQuiescent", target: "halted" },
      on: {
        RISK_PROPOSED: { actions: "rejectProposal" },
        PRODUCT_STOPPED: [
          { guard: "productKnown", actions: "markProductStopped" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_HALTED: [
          { guard: "productKnown", actions: "markProductHalted" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_FAILED: [
          { guard: "productKnown", actions: "markProductFailed" },
          { actions: "recordUnknownProduct" },
        ],
        PRODUCT_EXPOSURE_REPORTED: [
          { guard: "productKnown", actions: "recordExposure" },
          { actions: "recordUnknownProduct" },
        ],
        KILL_SWITCH_ENGAGED: [
          { guard: "controlIdPresent", actions: "requestKillSwitch" },
          { actions: "recordControlDenied" },
        ],
      },
    },
    complete: {
      on: { RESET: { target: "idle", actions: "resetPortfolio" } },
    },
    halted: {
      on: { RESET: { target: "idle", actions: "resetPortfolio" } },
    },
  },
});
