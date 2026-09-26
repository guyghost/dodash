import {
  DASHBOARD_REMOTE_PHASES,
  LIVE_TRADING_POLICY,
  type DashboardDirectCommand,
  type DashboardError,
  type DashboardRemotePhase,
} from "@dodash/models";

export interface AgentConfigurationView {
  readonly productId: string;
  readonly timeframe: string;
  readonly strategyIds: readonly string[];
  readonly intervalSeconds: number;
  readonly executionMode: "paper" | "live";
}

export interface AgentStateView {
  readonly enabled: boolean;
  readonly phase: DashboardRemotePhase;
  readonly updatedAt: number;
  readonly configuration: AgentConfigurationView | null;
  readonly portfolio: {
    readonly cash: number;
    readonly positionQuantity: number;
    readonly averagePrice: number;
  };
  readonly dailyPnl: number;
  readonly nextWakeAt: number | null;
  readonly lastTradeAt: number | null;
  readonly lastCycle: {
    readonly cycleId: string;
    readonly outcome: string;
    readonly marketPrice: number | null;
    readonly signalCount: number;
    readonly completedAt: number;
  } | null;
  /** dao #34 : hiérarchie portefeuille transportée par le contrat `/state`. */
  readonly portfolioSummary: PortfolioSummaryView;
  readonly paperValuation: PaperValuationResultView | null;
  readonly indicators: {
    readonly rsi: number;
    readonly emaFast: number;
    readonly emaSlow: number;
    readonly macd: number;
    readonly atr: number;
  } | null;
}

export interface CycleView {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number | null;
  readonly phase: string;
  readonly outcome: string;
}

export interface PnlEquityPointView {
  readonly t: number;
  readonly equity: number | null;
  readonly valuation: PaperValuationView;
}

export interface PnlCycleView {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number | null;
  readonly outcome: string;
  readonly marketPrice: number | null;
  readonly valuation: PaperValuationView | null;
  readonly side: "BUY" | "SELL" | null;
  readonly quantity: number | null;
  readonly fillPrice: number | null;
  readonly fee: number | null;
  readonly realizedPnl: number | null;
  readonly slippageBps: number | null;
}

export interface PnlHistoryView {
  readonly equityCurve: readonly PnlEquityPointView[];
  readonly cycles: readonly PnlCycleView[];
  readonly openPosition:
    | { readonly quantity: number; readonly averagePrice: number }
    | null;
  readonly protection:
    | {
        readonly stopLossPrice: number;
        readonly takeProfitPrice: number;
        readonly protectiveOrderConfirmed: boolean;
      }
    | null;
}

export interface PaperValuationView {
  readonly asOf: number;
  readonly equity: number | null;
  readonly exposureNotional: number | null;
  readonly exposureQuality: "fresh" | "stale" | "unavailable";
  readonly markPrice: number | null;
  readonly markSource: "COINBASE_CANDLE_CLOSE" | null;
  readonly timeframe: string | null;
  readonly candleClosedAt: number | null;
  readonly ageMs: number | null;
  readonly quality: "fresh" | "stale" | "unavailable";
}

export type PaperValuationResultView =
  | { readonly ok: true; readonly value: PaperValuationView }
  | { readonly ok: false; readonly error: { readonly code: string } };

export type PortfolioProductStatusView = "running" | "stopped" | "halted" | "failed";

export interface PortfolioLastCycleView {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number;
  readonly outcome: string;
  readonly marketPrice: number | null;
}

export interface PortfolioProductView {
  readonly productId: string;
  readonly phase: string;
  readonly status: PortfolioProductStatusView;
  readonly cash: number;
  readonly positionQuantity: number;
  readonly averagePrice: number;
  readonly marketPrice: number | null;
  readonly valuation: PaperValuationView;
  readonly grossExposure: number | null;
  readonly exposureQuality: "fresh" | "stale" | "unavailable";
  readonly maxGrossExposure: number;
  readonly dailyPnl: number;
  readonly lastCycle: PortfolioLastCycleView | null;
}

export interface PortfolioConsolidatedView {
  readonly equity: number | null;
  readonly valuationQuality: "fresh" | "stale" | "unavailable";
  readonly grossExposure: number | null;
  readonly exposureQuality: "fresh" | "stale" | "unavailable";
  readonly maxGrossExposure: number;
  readonly dailyPnl: number;
  readonly maxDailyLoss: number;
}

/** dao #32 : `portfolio` = instance multi-produits ; `single-product` = vue inchangée. */
export type PortfolioSummaryView =
  | {
      readonly kind: "portfolio";
      readonly phase: string;
      readonly killSwitchActive: boolean;
      readonly asOf: number;
      readonly products: readonly PortfolioProductView[];
      readonly consolidated: PortfolioConsolidatedView;
    }
  | { readonly kind: "single-product" };

export interface StartConfiguration {
  readonly productId: string;
  readonly timeframe: string;
  readonly strategyIds: readonly string[];
  readonly executionMode: "paper" | "live";
}

export const createStartConfiguration = (
  input: StartConfiguration,
): StartConfiguration =>
  input.executionMode === "paper"
    ? Object.freeze({
        ...input,
        strategyIds: Object.freeze([...input.strategyIds]),
      })
    : Object.freeze({
        productId: input.productId,
        timeframe: LIVE_TRADING_POLICY.timeframe,
        strategyIds: LIVE_TRADING_POLICY.strategyIds,
        executionMode: "live" as const,
      });

export interface DashboardGateway {
  loadState(agentName: string): Promise<AgentStateView>;
  loadCycles(agentName: string): Promise<readonly CycleView[]>;
  loadPnlHistory(agentName: string): Promise<PnlHistoryView>;
  command(
    agentName: string,
    command: DashboardDirectCommand | "kill",
    configuration?: StartConfiguration,
  ): Promise<AgentStateView>;
  submitPerpOrder(
    agentName: string,
    body: PerpOrderRequestBody,
  ): Promise<PerpOrderSubmissionView>;
}

export interface PerpOrderRequestBody {
  readonly intent: {
    readonly productId: string;
    readonly side: "BUY" | "SELL";
    readonly quantity: number;
    readonly markPrice: number;
    readonly leverage: number;
  };
  readonly gate: {
    readonly dailyPnl: number;
    readonly positionQuantity?: number;
    readonly otherGrossExposureNotional?: number;
  };
  readonly clientOrderId: string;
}

export interface PerpOrderSubmissionView {
  readonly status: "SETTLED" | "REFUSED" | "FAILED";
  readonly outcome?: "ACCEPTED" | "REJECTED";
  readonly reasonCode?: string;
  readonly errorCode?: string;
  readonly clientOrderId?: string;
}

export class DashboardRequestError extends Error {
  constructor(readonly dashboardError: DashboardError) {
    super(dashboardError.code);
  }
}

const phases = new Set<string>(DASHBOARD_REMOTE_PHASES);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const invalidResponse = (): DashboardRequestError =>
  new DashboardRequestError({ code: "INVALID_RESPONSE", retryable: false });

const optionalTime = (value: unknown): number | null => {
  if (value === null) return null;
  if (Number.isSafeInteger(value) && Number(value) >= 0) {
    return value as number;
  }
  throw invalidResponse();
};

const parseConfiguration = (value: unknown): AgentConfigurationView | null => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.productId !== "string" ||
    typeof value.timeframe !== "string" ||
    !Array.isArray(value.strategyIds) ||
    !value.strategyIds.every((item) => typeof item === "string") ||
    !Number.isSafeInteger(value.intervalSeconds) ||
    (value.executionMode !== "paper" && value.executionMode !== "live")
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    productId: value.productId,
    timeframe: value.timeframe,
    strategyIds: Object.freeze([...value.strategyIds]),
    intervalSeconds: Number(value.intervalSeconds),
    executionMode: value.executionMode,
  });
};

const parsePaperValuation = (value: unknown): PaperValuationView | null => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isSafeTime(value.asOf) ||
    !(value.equity === null || isFiniteNumber(value.equity)) ||
    !(value.exposureNotional === null || isNonNegativeFinite(value.exposureNotional)) ||
    (value.exposureQuality !== "fresh" && value.exposureQuality !== "stale" && value.exposureQuality !== "unavailable") ||
    !(value.markPrice === null || (isFiniteNumber(value.markPrice) && value.markPrice > 0)) ||
    !(value.markSource === null || value.markSource === "COINBASE_CANDLE_CLOSE") ||
    !(value.timeframe === null || (typeof value.timeframe === "string" && value.timeframe.length > 0)) ||
    !(value.candleClosedAt === null || isSafeTime(value.candleClosedAt)) ||
    !(value.ageMs === null || isSafeTime(value.ageMs)) ||
    (value.quality !== "fresh" && value.quality !== "stale" && value.quality !== "unavailable")
  ) {
    throw invalidResponse();
  }
  const hasMark = value.markPrice !== null;
  if (
    hasMark !== (value.markSource !== null) ||
    hasMark !== (value.timeframe !== null) ||
    hasMark !== (value.candleClosedAt !== null) ||
    hasMark !== (value.ageMs !== null) ||
    (typeof value.candleClosedAt === "number" &&
      typeof value.asOf === "number" &&
      value.candleClosedAt > value.asOf) ||
    (value.quality === "unavailable" && hasMark) ||
    ((value.quality === "fresh" || value.quality === "stale") && !hasMark) ||
    (value.exposureNotional === null && value.exposureQuality !== "unavailable") ||
    (value.exposureNotional !== null && value.exposureQuality === "unavailable")
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    asOf: value.asOf as number,
    equity: value.equity,
    exposureNotional: value.exposureNotional as number | null,
    exposureQuality: value.exposureQuality,
    markPrice: value.markPrice,
    markSource: value.markSource as PaperValuationView["markSource"],
    timeframe: value.timeframe as string | null,
    candleClosedAt: value.candleClosedAt as number | null,
    ageMs: value.ageMs as number | null,
    quality: value.quality,
  });
};

const parsePaperValuationResult = (
  value: unknown,
): PaperValuationResultView | null => {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.ok !== "boolean") throw invalidResponse();
  if (value.ok) {
    const projected = parsePaperValuation(value.value);
    if (projected === null) throw invalidResponse();
    return Object.freeze({ ok: true, value: projected });
  }
  if (!isRecord(value.error) || typeof value.error.code !== "string") {
    throw invalidResponse();
  }
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: value.error.code }),
  });
};

const parseIndicators = (value: unknown): AgentStateView["indicators"] => {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.rsi) ||
    !isFiniteNumber(value.emaFast) ||
    !isFiniteNumber(value.emaSlow) ||
    !isFiniteNumber(value.macd) ||
    !isFiniteNumber(value.atr)
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    rsi: value.rsi,
    emaFast: value.emaFast,
    emaSlow: value.emaSlow,
    macd: value.macd,
    atr: value.atr,
  });
};

export const parseAgentState = (value: unknown): AgentStateView => {
  if (!isRecord(value) || !isRecord(value.machine) || !isRecord(value.portfolio)) {
    throw invalidResponse();
  }
  const phase = value.machine.value;
  if (
    typeof phase !== "string" ||
    !phases.has(phase) ||
    typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.updatedAt) ||
    !isNonNegativeFinite(value.portfolio.cash) ||
    !isNonNegativeFinite(value.portfolio.positionQuantity) ||
    !isFiniteNumber(value.portfolio.averagePrice) ||
    !isFiniteNumber(value.dailyPnl)
  ) {
    throw invalidResponse();
  }
  const machineContext = value.machine.context;
  if (!isRecord(machineContext)) throw invalidResponse();

  // dao #34 (models/state-portfolio-contract.md §5) : la hiérarchie
  // portefeuille voyage dans le contrat `/state` ; le parseur strict de
  // #32 (parsePortfolioSummary) revalide `value` intégralement, et un
  // échec local `ok: false` est une erreur typée, jamais un rendu dégradé.
  const portfolioEnvelope = value.portfolioSummary;
  if (!isRecord(portfolioEnvelope) || portfolioEnvelope.ok !== true || !("value" in portfolioEnvelope)) {
    throw invalidResponse();
  }
  const portfolioSummary = parsePortfolioSummary(portfolioEnvelope.value);
  const paperValuation = parsePaperValuationResult(value.paperValuation ?? null);
  if (paperValuation?.ok === true) {
    const measurement = paperValuation.value;
    const expectedEquity = value.portfolio.positionQuantity === 0
      ? value.portfolio.cash
      : measurement.markPrice === null
        ? null
        : value.portfolio.cash + value.portfolio.positionQuantity * measurement.markPrice;
    const expectedExposure = value.portfolio.positionQuantity === 0
      ? 0
      : measurement.markPrice === null
        ? null
        : Math.abs(value.portfolio.positionQuantity) * measurement.markPrice;
    const expectedExposureQuality = value.portfolio.positionQuantity === 0
      ? "fresh"
      : expectedExposure === null
        ? "unavailable"
        : measurement.quality;
    if (
      measurement.equity !== expectedEquity ||
      measurement.exposureNotional !== expectedExposure ||
      measurement.exposureQuality !== expectedExposureQuality
    ) {
      throw invalidResponse();
    }
  }

  const lastCycleValue = value.lastCycle;
  let lastCycle: AgentStateView["lastCycle"] = null;
  if (lastCycleValue !== null) {
    if (
      !isRecord(lastCycleValue) ||
      typeof lastCycleValue.cycleId !== "string" ||
      typeof lastCycleValue.outcome !== "string" ||
      !Number.isSafeInteger(lastCycleValue.completedAt) ||
      !Number.isSafeInteger(lastCycleValue.signalCount) ||
      !(lastCycleValue.marketPrice === null || isFiniteNumber(lastCycleValue.marketPrice))
    ) {
      throw invalidResponse();
    }
    lastCycle = Object.freeze({
      cycleId: lastCycleValue.cycleId,
      outcome: lastCycleValue.outcome,
      marketPrice: lastCycleValue.marketPrice,
      signalCount: Number(lastCycleValue.signalCount),
      completedAt: Number(lastCycleValue.completedAt),
    });
  }

  return Object.freeze({
    enabled: value.enabled,
    phase: phase as DashboardRemotePhase,
    updatedAt: Number(value.updatedAt),
    configuration: parseConfiguration(value.configuration),
    portfolio: Object.freeze({
      cash: value.portfolio.cash,
      positionQuantity: value.portfolio.positionQuantity,
      averagePrice: value.portfolio.averagePrice,
    }),
    dailyPnl: value.dailyPnl,
    nextWakeAt: optionalTime(machineContext.nextWakeAt),
    lastTradeAt: optionalTime(value.lastTradeAt),
    lastCycle,
    portfolioSummary,
    paperValuation,
    indicators: parseIndicators(value.previousIndicators),
  });
};

export const parseCycles = (value: unknown): readonly CycleView[] => {
  if (!Array.isArray(value)) throw invalidResponse();
  return Object.freeze(
    value.slice(0, 50).map((item) => {
      if (
        !isRecord(item) ||
        typeof item.cycle_id !== "string" ||
        !Number.isSafeInteger(item.triggered_at) ||
        !(item.completed_at === null || Number.isSafeInteger(item.completed_at)) ||
        typeof item.phase !== "string" ||
        typeof item.outcome !== "string"
      ) {
        throw invalidResponse();
      }
      return Object.freeze({
        cycleId: item.cycle_id,
        triggeredAt: Number(item.triggered_at),
        completedAt: item.completed_at === null ? null : Number(item.completed_at),
        phase: item.phase,
        outcome: item.outcome,
      });
    }),
  );
};

const optionalPositiveFinite = (value: unknown): number | null => {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value <= 0) throw invalidResponse();
  return value;
};

const optionalTradeField = (
  side: unknown,
  value: unknown,
  positive: boolean,
): number | null => {
  if (side === null) {
    if (value !== null) throw invalidResponse();
    return null;
  }
  if (value === null) return null;
  if (!isFiniteNumber(value) || (positive && value <= 0)) {
    throw invalidResponse();
  }
  return value;
};

export const parsePnlHistory = (value: unknown): PnlHistoryView => {
  if (!isRecord(value) || !Array.isArray(value.equityCurve) || !Array.isArray(value.cycles)) {
    throw invalidResponse();
  }
  const equityCurve = value.equityCurve.slice(0, 50).map((point) => {
    if (!isRecord(point) || !isSafeTime(point.t)) {
      throw invalidResponse();
    }
    if (!(point.equity === null || isFiniteNumber(point.equity))) throw invalidResponse();
    const isLegacyPoint = point.valuation === undefined || point.valuation === null;
    const valuation = isLegacyPoint
      ? Object.freeze({
          asOf: point.t,
          equity: null,
          exposureNotional: null,
          exposureQuality: "unavailable" as const,
          markPrice: null,
          markSource: null,
          timeframe: null,
          candleClosedAt: null,
          ageMs: null,
          quality: "unavailable" as const,
        })
      : parsePaperValuation(point.valuation);
    if (
      valuation === null ||
      (!isLegacyPoint && !(point.equity === null || isFiniteNumber(point.equity))) ||
      (!isLegacyPoint && point.equity !== valuation.equity) ||
      point.t !== valuation.asOf
    ) {
      throw invalidResponse();
    }
    return Object.freeze({
      t: point.t,
      equity: isLegacyPoint ? null : point.equity as number | null,
      valuation,
    });
  });
  const cycles = value.cycles.slice(0, 50).map((cycle) => {
    if (
      !isRecord(cycle) ||
      typeof cycle.cycleId !== "string" ||
      !isSafeTime(cycle.triggeredAt) ||
      !(cycle.completedAt === null || isSafeTime(cycle.completedAt)) ||
      typeof cycle.outcome !== "string" ||
      !(cycle.marketPrice === null || isFiniteNumber(cycle.marketPrice)) ||
      (cycle.side !== "BUY" && cycle.side !== "SELL" && cycle.side !== null)
    ) {
      throw invalidResponse();
    }
    const valuation = parsePaperValuation(cycle.valuation ?? null);
    return Object.freeze({
      cycleId: cycle.cycleId,
      triggeredAt: cycle.triggeredAt,
      completedAt: cycle.completedAt,
      outcome: cycle.outcome,
      marketPrice: optionalPositiveFinite(cycle.marketPrice),
      valuation,
      side: cycle.side,
      quantity: optionalTradeField(cycle.side, cycle.quantity, true),
      fillPrice: optionalTradeField(cycle.side, cycle.fillPrice, true),
      fee: optionalTradeField(cycle.side, cycle.fee, true),
      realizedPnl: optionalTradeField(cycle.side, cycle.realizedPnl, false),
      slippageBps: optionalTradeField(cycle.side, cycle.slippageBps, false),
    });
  });
  let openPosition: PnlHistoryView["openPosition"] = null;
  if (value.openPosition !== null) {
    if (
      !isRecord(value.openPosition) ||
      !isFiniteNumber(value.openPosition.quantity) ||
      !isFiniteNumber(value.openPosition.averagePrice)
    ) {
      throw invalidResponse();
    }
    openPosition = Object.freeze({
      quantity: value.openPosition.quantity,
      averagePrice: value.openPosition.averagePrice,
    });
  }
  let protection: PnlHistoryView["protection"] = null;
  if (value.protection !== null) {
    if (
      !isRecord(value.protection) ||
      !isFiniteNumber(value.protection.stopLossPrice) ||
      !isFiniteNumber(value.protection.takeProfitPrice) ||
      typeof value.protection.protectiveOrderConfirmed !== "boolean"
    ) {
      throw invalidResponse();
    }
    protection = Object.freeze({
      stopLossPrice: value.protection.stopLossPrice,
      takeProfitPrice: value.protection.takeProfitPrice,
      protectiveOrderConfirmed: value.protection.protectiveOrderConfirmed,
    });
  }
  return Object.freeze({
    equityCurve: Object.freeze(equityCurve),
    cycles: Object.freeze(cycles),
    openPosition,
    protection,
  });
};

const PORTFOLIO_PRODUCT_PHASES = new Set<string>(DASHBOARD_REMOTE_PHASES);
const PORTFOLIO_PRODUCT_STATUSES = new Set<string>([
  "running",
  "stopped",
  "halted",
  "failed",
]);
const PORTFOLIO_MAX_PRODUCTS = 8;

/**
 * dao #32 : revalidation stricte de la projection portefeuille (V3) :
 * types, finitude, domaines, ensembles fermés, tableau produits plafonné
 * au nombre de créneaux admissibles. Toute dérive = erreur typée, jamais
 * un rendu dégradé.
 */
export const parsePortfolioSummary = (value: unknown): PortfolioSummaryView => {
  if (!isRecord(value) || (value.kind !== "portfolio" && value.kind !== "single-product")) {
    throw invalidResponse();
  }
  if (value.kind === "single-product") return Object.freeze(value) as PortfolioSummaryView;

  if (
    typeof value.phase !== "string" ||
    typeof value.killSwitchActive !== "boolean" ||
    !(value.asOf === undefined || isSafeTime(value.asOf)) ||
    !Array.isArray(value.products) ||
    !isRecord(value.consolidated)
  ) {
    throw invalidResponse();
  }
  const asOf = typeof value.asOf === "number" ? value.asOf : 0;
  const products = value.products.slice(0, PORTFOLIO_MAX_PRODUCTS).map((item) => {
    if (
      !isRecord(item) ||
      typeof item.productId !== "string" ||
      item.productId.length === 0 ||
      typeof item.phase !== "string" ||
      !PORTFOLIO_PRODUCT_PHASES.has(item.phase) ||
      typeof item.status !== "string" ||
      !PORTFOLIO_PRODUCT_STATUSES.has(item.status) ||
      !isFiniteNumber(item.cash) ||
      !isNonNegativeFinite(item.positionQuantity) ||
      !isNonNegativeFinite(item.averagePrice) ||
      !isFiniteNumber(item.dailyPnl) ||
      !isFiniteNumber(item.maxGrossExposure) ||
      item.maxGrossExposure <= 0 ||
      !(item.marketPrice === undefined || item.marketPrice === null || isFiniteNumber(item.marketPrice))
    ) {
      throw invalidResponse();
    }
    const isLegacyProduct = item.valuation === undefined;
    const parsedValuation = isLegacyProduct ? null : parsePaperValuation(item.valuation);
    if (!isLegacyProduct && parsedValuation === null) throw invalidResponse();
    const valuation = parsedValuation ?? Object.freeze({
      asOf,
      equity: item.positionQuantity === 0 ? item.cash : null,
      exposureNotional: item.positionQuantity === 0 ? 0 : null,
      exposureQuality: item.positionQuantity === 0 ? "fresh" as const : "unavailable" as const,
      markPrice: null,
      markSource: null,
      timeframe: null,
      candleClosedAt: null,
      ageMs: null,
      quality: "unavailable" as const,
    });
    const marketPrice = isLegacyProduct ? null : item.marketPrice as number | null;
    const grossExposure = isLegacyProduct
      ? item.positionQuantity === 0 ? 0 : null
      : item.grossExposure;
    const exposureQuality = isLegacyProduct
      ? item.positionQuantity === 0 ? "fresh" as const : "unavailable" as const
      : item.exposureQuality;
    const invalidNewMeasurement = !isLegacyProduct && (
      !(item.grossExposure === null || isNonNegativeFinite(item.grossExposure)) ||
      (item.exposureQuality !== "fresh" && item.exposureQuality !== "stale" && item.exposureQuality !== "unavailable") ||
      valuation.markPrice !== marketPrice ||
      valuation.equity !== (
        item.positionQuantity === 0
          ? item.cash
          : valuation.markPrice === null
            ? null
            : item.cash + item.positionQuantity * valuation.markPrice
      ) ||
      valuation.exposureNotional !== grossExposure ||
      valuation.exposureQuality !== exposureQuality ||
      (item.positionQuantity === 0 && (grossExposure !== 0 || exposureQuality !== "fresh")) ||
      (item.positionQuantity > 0 && grossExposure === null && exposureQuality !== "unavailable") ||
      (item.positionQuantity > 0 && grossExposure !== null &&
        (valuation.markPrice === null || grossExposure !== item.positionQuantity * valuation.markPrice || exposureQuality !== valuation.quality))
    );
    if (valuation.asOf !== asOf || invalidNewMeasurement) {
      throw invalidResponse();
    }
    let lastCycle: PortfolioLastCycleView | null = null;
    if (item.lastCycle !== null) {
      if (
        !isRecord(item.lastCycle) ||
        typeof item.lastCycle.cycleId !== "string" ||
        item.lastCycle.cycleId.length === 0 ||
        !isSafeTime(item.lastCycle.triggeredAt) ||
        !isSafeTime(item.lastCycle.completedAt) ||
        typeof item.lastCycle.outcome !== "string" ||
        item.lastCycle.outcome.length === 0 ||
        !(item.lastCycle.marketPrice === null || isFiniteNumber(item.lastCycle.marketPrice))
      ) {
        throw invalidResponse();
      }
      lastCycle = Object.freeze({
        cycleId: item.lastCycle.cycleId,
        triggeredAt: item.lastCycle.triggeredAt,
        completedAt: item.lastCycle.completedAt,
        outcome: item.lastCycle.outcome,
        marketPrice: item.lastCycle.marketPrice,
      });
    }
    return Object.freeze({
      productId: item.productId,
      phase: item.phase,
      status: item.status as PortfolioProductStatusView,
      cash: Number(item.cash),
      positionQuantity: Number(item.positionQuantity),
      averagePrice: Number(item.averagePrice),
      marketPrice,
      valuation,
      grossExposure: grossExposure as number | null,
      exposureQuality: exposureQuality as "fresh" | "stale" | "unavailable",
      maxGrossExposure: Number(item.maxGrossExposure),
      dailyPnl: Number(item.dailyPnl),
      lastCycle,
    });
  });
  const consolidated = value.consolidated;
  if (
    !isFiniteNumber(consolidated.maxGrossExposure) ||
    consolidated.maxGrossExposure <= 0 ||
    !isFiniteNumber(consolidated.dailyPnl) ||
    !isFiniteNumber(consolidated.maxDailyLoss) ||
    consolidated.maxDailyLoss <= 0
  ) {
    throw invalidResponse();
  }
  if (
    ("equity" in consolidated && !(consolidated.equity === null || isFiniteNumber(consolidated.equity))) ||
    ("grossExposure" in consolidated && !(consolidated.grossExposure === null || isNonNegativeFinite(consolidated.grossExposure))) ||
    ("valuationQuality" in consolidated && consolidated.valuationQuality !== "fresh" && consolidated.valuationQuality !== "stale" && consolidated.valuationQuality !== "unavailable") ||
    ("exposureQuality" in consolidated && consolidated.exposureQuality !== "fresh" && consolidated.exposureQuality !== "stale" && consolidated.exposureQuality !== "unavailable")
  ) {
    throw invalidResponse();
  }
  const hasConsolidatedValuation =
    isFiniteNumber(consolidated.equity) || consolidated.equity === null;
  const hasConsolidatedQuality =
    consolidated.valuationQuality === "fresh" || consolidated.valuationQuality === "stale" || consolidated.valuationQuality === "unavailable";
  const hasConsolidatedExposureQuality =
    consolidated.exposureQuality === "fresh" || consolidated.exposureQuality === "stale" || consolidated.exposureQuality === "unavailable";
  const hasNewConsolidatedContract =
    hasConsolidatedValuation &&
    hasConsolidatedQuality &&
    hasConsolidatedExposureQuality &&
    (consolidated.grossExposure === null || isNonNegativeFinite(consolidated.grossExposure));
  const calculatedEquity = products.every((product) => product.valuation.equity !== null)
    ? products.reduce((sum, product) => sum + (product.valuation.equity ?? 0), 0)
    : null;
  const calculatedExposure = products.every((product) => product.grossExposure !== null)
    ? products.reduce((sum, product) => sum + (product.grossExposure ?? 0), 0)
    : null;
  const calculatedValuationQuality = calculatedEquity === null || products.some((product) => product.valuation.quality === "unavailable")
    ? "unavailable" as const
    : products.some((product) => product.valuation.quality === "stale")
      ? "stale" as const
      : "fresh" as const;
  const calculatedExposureQuality = calculatedExposure === null || products.some((product) => product.exposureQuality === "unavailable")
    ? "unavailable" as const
    : products.some((product) => product.exposureQuality === "stale")
      ? "stale" as const
      : "fresh" as const;
  if (
    !Number.isFinite(products.reduce((sum, product) => sum + product.dailyPnl, 0)) ||
    (hasNewConsolidatedContract && value.products.length <= PORTFOLIO_MAX_PRODUCTS &&
      (consolidated.equity !== calculatedEquity ||
        consolidated.valuationQuality !== calculatedValuationQuality ||
        consolidated.grossExposure !== calculatedExposure ||
        consolidated.exposureQuality !== calculatedExposureQuality))
  ) {
    throw invalidResponse();
  }
  const keepFullConsolidated = hasNewConsolidatedContract && value.products.length > PORTFOLIO_MAX_PRODUCTS;
  const consolidatedEquity = keepFullConsolidated ? consolidated.equity as number | null : calculatedEquity;
  const consolidatedValuationQuality = keepFullConsolidated ? consolidated.valuationQuality as "fresh" | "stale" | "unavailable" : calculatedValuationQuality;
  const consolidatedExposure = keepFullConsolidated ? consolidated.grossExposure as number | null : calculatedExposure;
  const consolidatedExposureQuality = keepFullConsolidated ? consolidated.exposureQuality as "fresh" | "stale" | "unavailable" : calculatedExposureQuality;
  return Object.freeze({
    kind: "portfolio" as const,
    phase: value.phase,
    killSwitchActive: value.killSwitchActive,
    asOf,
    products: Object.freeze(products),
    consolidated: Object.freeze({
      equity: consolidatedEquity,
      valuationQuality: consolidatedValuationQuality,
      grossExposure: consolidatedExposure,
      exposureQuality: consolidatedExposureQuality,
      maxGrossExposure: Number(consolidated.maxGrossExposure),
      dailyPnl: Number(consolidated.dailyPnl),
      maxDailyLoss: Number(consolidated.maxDailyLoss),
    }),
  });
};

const boundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 1_000_000) throw invalidResponse();
  const text = await response.text();
  if (text.length > 1_000_000) throw invalidResponse();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
};

const normalizeBase = (apiBaseUrl: string): string =>
  apiBaseUrl.trim().replace(/\/+$/, "");

export const createHttpGateway = (
  apiBaseUrl: string,
  token: string,
  request: typeof fetch = fetch,
): DashboardGateway => {
  const base = normalizeBase(apiBaseUrl);
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        },
      });
    } catch {
      throw new DashboardRequestError({ code: "REQUEST_FAILED", retryable: true });
    }
    if (!response.ok) {
      throw new DashboardRequestError({
        code: "REQUEST_FAILED",
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return boundedJson(response);
  };

  return Object.freeze({
    loadState: async (agentName: string) =>
      parseAgentState(await call(`/api/agents/${encodeURIComponent(agentName)}/state`)),
    loadCycles: async (agentName: string) =>
      parseCycles(await call(`/api/agents/${encodeURIComponent(agentName)}/cycles?limit=12`)),
    loadPnlHistory: async (agentName: string) =>
      parsePnlHistory(
        await call(`/api/agents/${encodeURIComponent(agentName)}/pnl?limit=30`),
      ),
    command: async (
      agentName: string,
      command: DashboardDirectCommand | "kill",
      configuration?: StartConfiguration,
    ) => {
      const payload = await call(`/api/agents/${encodeURIComponent(agentName)}/${command}`, {
        method: "POST",
        ...(command === "start" ? { body: JSON.stringify(configuration ?? {}) } : {}),
      });
      if (!isRecord(payload) || payload.ok !== true || !("state" in payload)) {
        throw invalidResponse();
      }
      return parseAgentState(payload.state);
    },
    submitPerpOrder: async (agentName: string, body: PerpOrderRequestBody) => {
      let response: Response;
      try {
        response = await request(`${base}/api/agents/${encodeURIComponent(agentName)}/perp-order`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch {
        throw new DashboardRequestError({ code: "REQUEST_FAILED", retryable: true });
      }
      const payload = await boundedJson(response);
      if (!isRecord(payload) || !isRecord(payload.result)) {
        if (isRecord(payload) && payload.ok === false && typeof payload.code === "string") {
          return {
            status: "FAILED" as const,
            errorCode: payload.code,
          };
        }
        throw invalidResponse();
      }
      const result = payload.result as Record<string, unknown>;
      if (
        result.status !== "SETTLED" &&
        result.status !== "REFUSED" &&
        result.status !== "FAILED"
      ) {
        throw invalidResponse();
      }
      const view: PerpOrderSubmissionView = {
        status: result.status,
        ...(result.outcome === "ACCEPTED" || result.outcome === "REJECTED"
          ? { outcome: result.outcome }
          : {}),
        ...(typeof result.reasonCode === "string"
          ? { reasonCode: result.reasonCode }
          : {}),
        ...(typeof result.errorCode === "string"
          ? { errorCode: result.errorCode }
          : {}),
        ...(typeof result.clientOrderId === "string"
          ? { clientOrderId: result.clientOrderId }
          : {}),
      };
      return Object.freeze(view);
    },
  });
};
