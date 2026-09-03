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
import type { PaperPortfolio } from "@dodash/paper-execution";
import type { DailyRiskWindow, ShutdownMode, WorkflowError } from "@dodash/models";

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
  readonly protectiveOrderId?: string;
}

export interface AccountReconciliation {
  readonly snapshotId: string;
  readonly observedAt: number;
  readonly portfolio: PaperPortfolio;
  readonly accountEquity: number;
  readonly otherExposureNotional: number;
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
      readonly protectiveOrderId?: string;
      readonly accountEquity?: number;
      readonly otherExposureNotional?: number;
      readonly observedAt?: number;
    }
  | {
      readonly status: "PROTECTION_FAILED";
      readonly exchangeOrderId: string | null;
      readonly portfolio: PaperPortfolio;
      readonly fill: Fill | null;
      readonly protectiveOrderId?: string;
      readonly accountEquity: number;
      readonly otherExposureNotional: number;
      readonly observedAt: number;
      readonly error: WorkflowError;
    }
  | {
      readonly status: "TERMINAL_FAILED";
      readonly exchangeOrderId: string | null;
      readonly fill: Fill | null;
      readonly error: WorkflowError;
    }
  | {
      readonly status: "NO_SELL_NEEDED";
      readonly portfolio: PaperPortfolio;
      readonly accountEquity: number;
      readonly otherExposureNotional: number;
      readonly observedAt: number;
    }
  | { readonly status: "REJECTED"; readonly error: WorkflowError }
  | {
      readonly status: "UNKNOWN";
      readonly exchangeOrderId?: string;
      readonly error: WorkflowError;
    };

export interface TradingCycleEffects {
  reconcileAccount(
    portfolio: PaperPortfolio,
    observedAt: number,
  ): Promise<Result<AccountReconciliation, WorkflowError>>;
  fetchMarketData(
    configuration: AgentConfiguration,
    triggeredAt: number,
  ): Promise<Result<MarketSnapshot, WorkflowError>>;
  /**
   * Couture funding optionnelle (models/funding-rate-strategy.md §3) :
   * taux alignés par suffixe sur les bougies passées, ou null si
   * indisponible — jamais d'exception, jamais de zéro substitué.
   * Câblée uniquement en mode perp avec réglages résolus (INV-F2, C3).
   */
  fetchFundingData?(configuration: AgentConfiguration,
    candles: readonly Candle[],
  ): Promise<readonly number[] | null>;
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
    riskDecision: Extract<RiskDecision, { readonly status: "APPROVED" }>,
    authorization: ExecutionAuthorization,
    marketPrice: number,
    portfolio: PaperPortfolio,
    triggeredAt: number,
  ): Promise<OrderSubmission>;
  reconcileOrder(
    intent: OrderIntent,
    riskDecision: Extract<RiskDecision, { readonly status: "APPROVED" }>,
    portfolio: PaperPortfolio,
  ): Promise<Result<OrderSubmission, WorkflowError>>;
  cancelCurrentEffect(
    shutdownMode: ShutdownMode,
  ): Promise<Result<void, WorkflowError>>;
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
  readonly dailyRiskWindow?: DailyRiskWindow | null;
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
  readonly dailyRiskWindow: DailyRiskWindow | null;
  readonly dailyPnl: number;
  readonly accountEquity: number | null;
  readonly otherExposureNotional: number;
}
