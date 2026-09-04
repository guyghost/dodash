import type { PaperPortfolio } from "@dodash/paper-execution";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import {
  resolveDailyRiskWindow,
  type CycleOutcome,
  type DailyRiskWindow,
  type WorkflowError,
} from "@dodash/models";

import type { AgentConfiguration } from "./configuration.js";
import type { PersistedTradingMachine } from "./machine-session.js";
import {
  portfolioProductIds,
  type PortfolioProductRuntime,
  type PortfolioSessionState,
} from "./portfolio-runtime.js";

export interface AgentScheduleState {
  readonly id: string;
  readonly intervalSeconds: number;
}

export interface CycleSummary {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number;
  readonly outcome: CycleOutcome;
  readonly marketPrice: number | null;
  readonly signalCount: number;
  readonly clientOrderId: string | null;
  readonly exchangeOrderId: string | null;
  readonly error: WorkflowError | null;
}

export interface TradingAgentState {
  readonly version: 1;
  readonly configuration: AgentConfiguration | null;
  readonly machine: PersistedTradingMachine | null;
  readonly enabled: boolean;
  readonly schedule: AgentScheduleState | null;
  readonly portfolio: PaperPortfolio;
  readonly dailyRiskWindow: DailyRiskWindow | null;
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly lastCycle: CycleSummary | null;
  /**
   * Session portefeuille multi-produits (models/multi-product-portfolio.md
   * §9.1, §9.7) : configuration figée du §7, orchestrateur du §5 et état
   * par produit. Null en mono-produit ; une restauration invalide est
   * refusée fermement via `portfolioRestoreError` (C3).
   */
  readonly portfolioSession: PortfolioSessionState | null;
  readonly portfolioRestoreError: "INVALID_PORTFOLIO_SNAPSHOT" | null;
  readonly updatedAt: number;
}

export const INITIAL_AGENT_STATE: TradingAgentState = Object.freeze({
  version: 1,
  configuration: null,
  machine: null,
  enabled: false,
  schedule: null,
  portfolio: Object.freeze({
    cash: 0,
    positionQuantity: 0,
    averagePrice: 0,
  }),
  dailyRiskWindow: null,
  dailyPnl: 0,
  lastTradeAt: null,
  previousIndicators: null,
  lastCycle: null,
  portfolioSession: null,
  portfolioRestoreError: null,
  updatedAt: 0,
});

export type { PortfolioProductRuntime, PortfolioSessionState };

/**
 * INV-P3 (quiescence) : le portefeuille reste actif tant qu'au moins un
 * créneau n'est pas terminal — l'arrêt d'un produit ne désactive jamais
 * les autres.
 */
export const portfolioIsEnabled = (session: PortfolioSessionState): boolean =>
  portfolioProductIds(session).some((productId) => {
    const product = session.products[productId];
    return product !== undefined && machineIsEnabled(product.machine.value);
  });

export interface LiveStartContinuity {
  readonly portfolio: PaperPortfolio;
  readonly dailyRiskWindow: DailyRiskWindow | null;
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly lastCycle: CycleSummary | null;
  readonly lastDecisionCandleClosedAt: number | null;
}

type ContinuityState = Pick<
  TradingAgentState,
  | "configuration"
  | "machine"
  | "portfolio"
  | "dailyPnl"
  | "lastTradeAt"
  | "previousIndicators"
  | "lastCycle"
> & { readonly dailyRiskWindow?: DailyRiskWindow | null };

export const resolveLiveStartContinuity = (
  current: ContinuityState,
  next: AgentConfiguration,
): LiveStartContinuity => {
  const preservesLiveState =
    current.configuration?.executionMode === "live" &&
    next.executionMode === "live" &&
    current.configuration.productId === next.productId;
  if (!preservesLiveState) {
    return Object.freeze({
      portfolio: Object.freeze({
        cash: next.initialCapital,
        positionQuantity: 0,
        averagePrice: 0,
      }),
      dailyRiskWindow: null,
      dailyPnl: 0,
      lastTradeAt: null,
      previousIndicators: null,
      lastCycle: null,
      lastDecisionCandleClosedAt: null,
    });
  }
  return Object.freeze({
    portfolio: current.portfolio,
    dailyRiskWindow: current.dailyRiskWindow ?? null,
    dailyPnl: current.dailyPnl,
    lastTradeAt: current.lastTradeAt,
    previousIndicators: current.previousIndicators,
    lastCycle: current.lastCycle,
    lastDecisionCandleClosedAt:
      current.machine?.context.lastDecisionCandleClosedAt ?? null,
  });
};

export const machineIsEnabled = (phase: string): boolean =>
  phase !== "stopped" && phase !== "failed" && phase !== "halted";

export interface CycleDailyRiskState {
  readonly window: DailyRiskWindow | null;
  readonly dailyPnl: number;
}

export const resolveCycleDailyRiskStart = (
  executionMode: AgentConfiguration["executionMode"],
  currentWindow: DailyRiskWindow | null,
  currentDailyPnl: number,
  triggeredAt: number,
  localMarkedEquity: number,
): CycleDailyRiskState =>
  executionMode === "live" || executionMode === "perp"
    ? Object.freeze({ window: currentWindow, dailyPnl: currentDailyPnl })
    : resolveDailyRiskWindow(currentWindow, triggeredAt, localMarkedEquity);

export const resolveCycleDailyRiskCompletion = (
  executionMode: AgentConfiguration["executionMode"],
  reconciledWindow: DailyRiskWindow | null,
  reconciledDailyPnl: number,
  triggeredAt: number,
  localMarkedEquity: number,
): CycleDailyRiskState =>
  executionMode === "live" || executionMode === "perp"
    ? Object.freeze({
        window: reconciledWindow,
        dailyPnl: reconciledDailyPnl,
      })
    : resolveDailyRiskWindow(
        reconciledWindow,
        triggeredAt,
        localMarkedEquity,
      );

export interface CycleInvocationIdentity {
  readonly loadCycleId: string | null;
  readonly cycleId: string;
  readonly triggeredAt: number;
}

export const resolveCycleInvocation = (
  machine: PersistedTradingMachine,
  triggerAlarm: boolean,
  now: number,
  newCycleId: string,
  resumeCycleIdOverride?: string | null,
): CycleInvocationIdentity => {
  const startsNewCycle = triggerAlarm && machine.value === "waiting";
  const resumeCycleId =
    resumeCycleIdOverride === undefined
      ? machine.context.cycleId
      : resumeCycleIdOverride;
  return Object.freeze({
    loadCycleId:
      machine.value === "waiting" || resumeCycleId === null
        ? null
        : resumeCycleId,
    cycleId: startsNewCycle
      ? newCycleId
      : machine.context.cycleId ?? newCycleId,
    triggeredAt: startsNewCycle
      ? now
      : machine.context.triggeredAt ?? now,
  });
};
