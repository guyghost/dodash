import type {
  Candle,
  Fill,
  OrderIntent,
  ProductId,
  Result,
  Signal,
  Timeframe,
} from "@dodash/domain";
import type { AllocationDecision } from "@dodash/allocator";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";
import type { RiskDecision } from "@dodash/risk";
import type { PaperPortfolio } from "@dodash/backtest";
import type { WorkflowError } from "@dodash/models";

import type { AgentConfiguration } from "./configuration.js";
import type { PersistedTradingMachine } from "./machine-session.js";

export interface MarketSnapshot {
  readonly productId: ProductId;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly source: "coinbase";
  readonly cached: boolean;
}

export interface CycleExecution {
  readonly exchangeOrderId: string;
  readonly fill: Fill | null;
}

export interface CycleArtifacts {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly market?: MarketSnapshot;
  readonly indicators?: IndicatorSnapshot;
  readonly signals?: readonly Signal[];
  readonly allocation?: AllocationDecision;
  readonly risk?: RiskDecision;
  readonly order?: OrderIntent;
  readonly execution?: CycleExecution;
}

export interface ExecutionAuthorization {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly credential?: unknown;
}

export type OrderSubmission =
  | {
      readonly status: "CONFIRMED";
      readonly exchangeOrderId: string;
      readonly portfolio: PaperPortfolio;
      readonly fill: Fill | null;
    }
  | { readonly status: "REJECTED"; readonly error: WorkflowError }
  | {
      readonly status: "UNKNOWN";
      readonly exchangeOrderId?: string;
      readonly error: WorkflowError;
    };

export interface TradingCycleEffects {
  fetchMarketData(
    configuration: AgentConfiguration,
    triggeredAt: number,
  ): Promise<Result<MarketSnapshot, WorkflowError>>;
  ensureSchedule(
    intervalSeconds: number,
  ): Promise<Result<{ readonly nextWakeAt: number }, WorkflowError>>;
  checkpoint(artifacts: CycleArtifacts): Promise<Result<void, WorkflowError>>;
  persistMachine(machine: PersistedTradingMachine): Promise<void>;
  persistOrderIntent(
    cycleId: string,
    intent: OrderIntent,
  ): Promise<Result<void, WorkflowError>>;
  authorize(
    intent: OrderIntent,
  ): Promise<Result<ExecutionAuthorization, WorkflowError>>;
  submitOrder(
    intent: OrderIntent,
    authorization: ExecutionAuthorization,
    marketPrice: number,
    portfolio: PaperPortfolio,
    triggeredAt: number,
  ): Promise<OrderSubmission>;
  reconcileOrder(
    intent: OrderIntent,
    portfolio: PaperPortfolio,
  ): Promise<Result<OrderSubmission, WorkflowError>>;
  cancelCurrentEffect(): Promise<Result<void, WorkflowError>>;
  persistCycle(
    artifacts: CycleArtifacts | null,
    machine: PersistedTradingMachine,
  ): Promise<Result<void, WorkflowError>>;
}

export interface RunTradingCycleInput {
  readonly agentId: string;
  readonly configuration: AgentConfiguration;
  readonly machine: PersistedTradingMachine;
  readonly artifacts: CycleArtifacts | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly portfolio: PaperPortfolio;
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly triggeredAt: number;
  readonly cycleId: string;
  readonly triggerAlarm: boolean;
  readonly effects: TradingCycleEffects;
}

export interface RunTradingCycleResult {
  readonly machine: PersistedTradingMachine;
  readonly artifacts: CycleArtifacts | null;
  readonly previousIndicators: IndicatorSnapshot | null;
  readonly portfolio: PaperPortfolio;
}
