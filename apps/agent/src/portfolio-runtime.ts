import {
  multiProductPortfolioMachine,
  tradingCycleMachine,
  type MultiProductPortfolioContext,
  type MultiProductPortfolioEvent,
  type MultiProductPortfolioInput,
  type PortfolioProductStatus,
} from "@dodash/models";
import type { ProductId } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import type { DailyRiskWindow } from "@dodash/models";
import type { PaperPortfolio } from "@dodash/paper-execution";
import { createActor } from "xstate";

import {
  parseMultiProductAgentConfiguration,
  type MultiProductAgentConfiguration,
} from "./configuration.js";
import type { PersistedTradingMachine } from "./machine-session.js";
import type { CycleSummary } from "./state.js";
import type { PortfolioAdmissionDecision } from "./types.js";

/**
 * Branchement runtime du portefeuille multi-produits
 * (models/multi-product-portfolio.md §9). Ce module porte la couture pure
 * : session de la machine orchestrateur du §5 (acteur durable du DO),
 * admission consolidée (INV-P5 : la garde décide, les effets transportent),
 * restauration fail-closed (C3) et helpers déterministes (INV-P4).
 * Aucun accès I/O ici : le Durable Object persiste les enregistrements
 * retournés.
 */

export interface PersistedPortfolioMachine {
  readonly value: string;
  readonly context: MultiProductPortfolioContext;
}

export interface PortfolioMachineSession {
  readonly phase: string;
  readonly context: MultiProductPortfolioContext;
  readonly record: PersistedPortfolioMachine;
  send(event: MultiProductPortfolioEvent): void;
  stop(): void;
}

const PORTFOLIO_PHASES: readonly string[] = Object.freeze([
  "validating",
  "rejected",
  "idle",
  "running",
  "draining",
  "complete",
  "halted",
]);

const toRecord = (
  snapshot: ReturnType<
    ReturnType<
      typeof createActor<typeof multiProductPortfolioMachine>
    >["getSnapshot"]
  >,
): PersistedPortfolioMachine => {
  if (typeof snapshot.value !== "string") {
    throw new Error("Portfolio must remain a top-level atomic state machine");
  }
  return Object.freeze({
    value: snapshot.value,
    context: structuredClone(snapshot.context),
  });
};

export const createPortfolioMachineSession = (
  input: MultiProductPortfolioInput,
  persisted?: PersistedPortfolioMachine,
): PortfolioMachineSession => {
  const restored =
    persisted === undefined
      ? undefined
      : multiProductPortfolioMachine.resolveState({
          value: persisted.value,
          context: structuredClone(persisted.context),
        });
  const actor = createActor(multiProductPortfolioMachine, {
    input,
    ...(restored === undefined ? {} : { snapshot: restored }),
  });
  actor.start();

  return {
    get phase() {
      const value = actor.getSnapshot().value;
      if (typeof value !== "string") {
        throw new Error("Portfolio entered a non-atomic state");
      }
      return value;
    },
    get context() {
      return actor.getSnapshot().context;
    },
    get record() {
      return toRecord(actor.getSnapshot());
    },
    send(event) {
      actor.send(event);
    },
    stop() {
      actor.stop();
    },
  };
};

/**
 * Envoi pur d'un événement à l'orchestrateur : retourne l'enregistrement
 * suivant sans persister — le shell (DO) décide de l'écriture.
 */
export const sendPortfolioEvent = (
  current: PersistedPortfolioMachine,
  event: MultiProductPortfolioEvent,
): PersistedPortfolioMachine => {
  const session = createPortfolioMachineSession(
    { products: current.context.products, limits: current.context.limits },
    current,
  );
  session.send(event);
  const record = session.record;
  session.stop();
  return record;
};

/**
 * Admission consolidée (models/multi-product-portfolio.md §9.3) : émet
 * `RISK_PROPOSED` vers l'orchestrateur du §5 et lit `lastDecision`. La
 * décision vient de la garde de la machine (INV-P5) ; la somme consolidée
 * remplace l'exposition du produit par sa projection (INV-P1) sous le
 * plafond, avec le coupe-circuit quotidien (INV-P2) et la quiescence
 * (INV-P3).
 */
export const proposePortfolioRisk = (
  current: PersistedPortfolioMachine,
  productId: string,
  proposedGrossExposure: number,
): { readonly record: PersistedPortfolioMachine; readonly decision: PortfolioAdmissionDecision } => {
  const record = sendPortfolioEvent(current, {
    type: "RISK_PROPOSED",
    productId,
    proposedGrossExposure,
  });
  const last = record.context.lastDecision;
  const own = last?.productId === productId ? last : null;
  return {
    record,
    decision: {
      approved: own?.approved === true,
      reasonCode: own === null ? null : own.reasonCode,
    },
  };
};

/**
 * État terminal fail-closed (C3) : enregistrement produit par la machine
 * elle-même sur une entrée invalide (liste vide ⇒ `validating` →
 * `rejected`). Aucune transition ne sort de `rejected`.
 */
export const rejectedPortfolioRecord = (): PersistedPortfolioMachine => {
  const session = createPortfolioMachineSession({
    products: [],
    limits: { maxGrossExposure: 1, maxDailyLoss: 1 },
  });
  const record = session.record;
  session.stop();
  return record;
};

export interface PortfolioProductRuntime {
  readonly machine: PersistedTradingMachine;
  readonly portfolio: PaperPortfolio;
  readonly dailyRiskWindow: DailyRiskWindow | null;
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly lastCycle: CycleSummary | null;
}

export interface PortfolioSessionState {
  readonly configuration: MultiProductAgentConfiguration;
  readonly portfolio: PersistedPortfolioMachine;
  readonly products: Readonly<Record<string, PortfolioProductRuntime>>;
}

/** INV-P4 : les créneaux sont figés triés à la configuration. */
export const portfolioProductIds = (
  session: PortfolioSessionState,
): readonly ProductId[] => session.configuration.products.map((p) => p.productId);

export const initialProductRuntime = (
  machine: PersistedTradingMachine,
  initialCapital: number,
): PortfolioProductRuntime =>
  Object.freeze({
    machine,
    portfolio: Object.freeze({
      cash: initialCapital,
      positionQuantity: 0,
      averagePrice: 0,
    }),
    dailyRiskWindow: null,
    dailyPnl: 0,
    lastTradeAt: null,
    previousIndicators: null,
    lastCycle: null,
  });

/** Exposition brute engagée d'un produit (notional), dernière connue. */
export const productGrossExposure = (
  portfolio: PaperPortfolio,
  marketPrice: number | null,
): number =>
  Math.abs(portfolio.positionQuantity) *
  (marketPrice ?? portfolio.averagePrice);

/** Quiescence par produit (§9.5) : phase terminale ⇒ événement portefeuille. */
export const portfolioEventForProductPhase = (
  productId: string,
  phase: string,
): MultiProductPortfolioEvent | null => {
  const terminal: PortfolioProductStatus | null =
    phase === "stopped"
      ? "stopped"
      : phase === "halted"
        ? "halted"
        : phase === "failed"
          ? "failed"
          : null;
  if (terminal === null) return null;
  if (terminal === "stopped") return { type: "PRODUCT_STOPPED", productId };
  if (terminal === "halted") return { type: "PRODUCT_HALTED", productId };
  return { type: "PRODUCT_FAILED", productId };
};

// ——— Restauration fail-closed (C3, règle models/agent-runtime.md) ———

export type RestoredPortfolioSession =
  | { readonly ok: true; readonly session: PortfolioSessionState }
  | { readonly ok: false; readonly reason: "INVALID_PORTFOLIO_SNAPSHOT" };

const invalid: RestoredPortfolioSession = {
  ok: false,
  reason: "INVALID_PORTFOLIO_SNAPSHOT",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isSortedUniqueStrings = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every((entry) => typeof entry === "string")) return false;
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1];
    const current = value[index];
    if (previous === undefined || current === undefined) return false;
    if (previous >= current) return false;
  }
  return true;
};

const isPortfolioStatus = (value: unknown): value is PortfolioProductStatus =>
  value === "running" ||
  value === "stopped" ||
  value === "halted" ||
  value === "failed";

const isStatusesRecord = (
  value: unknown,
  products: readonly string[],
): value is Readonly<Record<string, PortfolioProductStatus>> => {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, status]) =>
      products.includes(key) && isPortfolioStatus(status),
  );
};

const isExposureRecord = (
  value: unknown,
  products: readonly string[],
): value is Readonly<Record<string, number>> => {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, exposure]) => products.includes(key) && isFiniteNumber(exposure),
  );
};

const REASON_CODES: readonly string[] = Object.freeze([
  "CONSOLIDATED_DAILY_LOSS_LIMIT",
  "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
  "CONSOLIDATED_KILL_SWITCH",
  "UNKNOWN_PRODUCT",
]);

const ERROR_CODES: readonly string[] = Object.freeze([
  "CONTROL_PERMISSION_REQUIRED",
  "INVALID_PORTFOLIO_INPUT",
  "UNKNOWN_PRODUCT",
]);

const isPersistedPortfolioRecord = (
  value: unknown,
): value is PersistedPortfolioMachine => {
  if (!isRecord(value)) return false;
  if (
    typeof value.value !== "string" ||
    !PORTFOLIO_PHASES.includes(value.value)
  ) {
    return false;
  }
  const context: unknown = value.context;
  if (!isRecord(context)) return false;
  if (!isSortedUniqueStrings(context.products)) return false;
  const products = context.products as readonly string[];
  const limits = context.limits;
  if (
    !isRecord(limits) ||
    !isFiniteNumber(limits.maxGrossExposure) ||
    limits.maxGrossExposure <= 0 ||
    !isFiniteNumber(limits.maxDailyLoss) ||
    limits.maxDailyLoss <= 0
  ) {
    return false;
  }
  if (typeof context.killSwitchActive !== "boolean") return false;
  if (!isStatusesRecord(context.statuses, products)) return false;
  if (!isExposureRecord(context.exposure, products)) return false;
  if (!isExposureRecord(context.dailyPnl, products)) return false;
  const lastDecision = context.lastDecision;
  if (
    lastDecision !== null &&
    (!isRecord(lastDecision) ||
      typeof lastDecision.productId !== "string" ||
      !products.includes(lastDecision.productId) ||
      typeof lastDecision.approved !== "boolean" ||
      !(lastDecision.reasonCode === null ||
        (typeof lastDecision.reasonCode === "string" &&
          REASON_CODES.includes(lastDecision.reasonCode))))
  ) {
    return false;
  }
  const lastError = context.lastError;
  if (
    lastError !== null &&
    (!isRecord(lastError) ||
      typeof lastError.code !== "string" ||
      !ERROR_CODES.includes(lastError.code))
  ) {
    return false;
  }
  return true;
};

const isPaperPortfolio = (value: unknown): value is PaperPortfolio =>
  isRecord(value) &&
  isFiniteNumber(value.cash) &&
  isFiniteNumber(value.positionQuantity) &&
  isFiniteNumber(value.averagePrice);

const isProductRuntime = (value: unknown): value is PortfolioProductRuntime => {
  if (!isRecord(value)) return false;
  const machine = value.machine;
  if (!isRecord(machine) || typeof machine.value !== "string") return false;
  if (!isRecord(machine.context)) return false;
  if (!isPaperPortfolio(value.portfolio)) return false;
  const window = value.dailyRiskWindow;
  if (
    window !== null &&
    (!isRecord(window) ||
      !isFiniteNumber(window.utcDayStart) ||
      !isFiniteNumber(window.openingEquity))
  ) {
    return false;
  }
  if (!isFiniteNumber(value.dailyPnl)) return false;
  if (
    value.lastTradeAt !== null &&
    !isFiniteNumber(value.lastTradeAt)
  ) {
    return false;
  }
  if (value.previousIndicators !== null && !isRecord(value.previousIndicators)) {
    return false;
  }
  if (value.lastCycle !== null && !isRecord(value.lastCycle)) return false;
  return true;
};

/**
 * Restauration d'une session portefeuille persistée : tout écart au
 * contrat (configuration multi-produits revalidée par le même pipeline
 * pur, cohérence machine ↔ créneaux, enregistrements de machine
 * résolubles, champs ajoutés normalisés) est un refus fermé — jamais un
 * démarrage dégradé silencieux (C3).
 */
export const resolveRestoredPortfolioSession = (
  raw: unknown,
): RestoredPortfolioSession => {
  if (!isRecord(raw)) return invalid;
  const configuration = parseMultiProductAgentConfiguration(raw.configuration);
  if (
    !configuration.ok ||
    configuration.value.portfolioRisk === undefined ||
    configuration.value.products.length < 2
  ) {
    return invalid;
  }
  const portfolio = raw.portfolio;
  if (!isPersistedPortfolioRecord(portfolio)) return invalid;
  const expectedProducts = portfolioProductIds({
    configuration: configuration.value,
    portfolio,
    products: {},
  });
  if (
    JSON.stringify(portfolio.context.products) !==
    JSON.stringify(expectedProducts)
  ) {
    return invalid;
  }
  const products: Record<string, PortfolioProductRuntime> = {};
  const rawProducts = raw.products;
  if (!isRecord(rawProducts)) return invalid;
  for (const productId of expectedProducts) {
    const runtime = rawProducts[productId];
    if (!isProductRuntime(runtime)) return invalid;
    products[productId] = Object.freeze({
      ...runtime,
      machine: Object.freeze(runtime.machine),
      portfolio: Object.freeze(runtime.portfolio),
      dailyRiskWindow: runtime.dailyRiskWindow ?? null,
      dailyPnl: runtime.dailyPnl,
      lastTradeAt: runtime.lastTradeAt ?? null,
      previousIndicators: runtime.previousIndicators ?? null,
      lastCycle: runtime.lastCycle ?? null,
    });
  }
  if (Object.keys(rawProducts).length !== expectedProducts.length) {
    return invalid;
  }
  try {
    for (const productId of expectedProducts) {
      const runtime = products[productId];
      if (runtime === undefined) return invalid;
      tradingCycleMachine.resolveState({
        value: runtime.machine.value,
        context: structuredClone(runtime.machine.context),
      });
    }
    multiProductPortfolioMachine.resolveState({
      value: portfolio.value,
      context: structuredClone(portfolio.context),
    });
  } catch {
    return invalid;
  }
  return {
    ok: true,
    session: Object.freeze({
      configuration: configuration.value,
      portfolio: Object.freeze(portfolio),
      products: Object.freeze(products),
    }),
  };
};
