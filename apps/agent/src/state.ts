import type { PaperPortfolio } from "@dodash/backtest";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import type { CycleOutcome, WorkflowError } from "@dodash/models";

import type { AgentConfiguration } from "./configuration.js";
import type { PersistedTradingMachine } from "./machine-session.js";

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
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly lastCycle: CycleSummary | null;
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
  dailyPnl: 0,
  lastTradeAt: null,
  previousIndicators: null,
  lastCycle: null,
  updatedAt: 0,
});

export const machineIsEnabled = (phase: string): boolean =>
  phase !== "stopped" && phase !== "failed" && phase !== "halted";

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
