import { err, ok, type OrderIntent, type Result } from "@dodash/domain";
import type {
  ControlPermissions,
  WorkflowError,
} from "@dodash/models";
import type { RiskDecision } from "@dodash/risk";
import type { PaperPortfolio } from "@dodash/paper-execution";

import type { AgentConfiguration } from "./configuration.js";
import {
  executeCoinbaseKill,
  reconcileCoinbaseOwnedAccount,
} from "./coinbase-control.js";
import type { CoinbaseAccountSnapshot } from "./coinbase-account.js";
import type { HyperliquidExecutionSettings } from "./hyperliquid-settings.js";
import { resolveHyperliquidSettings } from "./hyperliquid-settings.js";
import {
  COINBASE_CREATE_ORDER_PATH,
  createCoinbaseAuthorization,
  resolveCoinbaseSettings,
  type CoinbaseExecutionSettings,
} from "./coinbase-execution.js";
import { fetchMarketSnapshot } from "./market-service.js";
import type { PersistedTradingMachine } from "./machine-session.js";
import type {
  CycleArtifacts,
  ExecutionAuthorization,
  OrderSubmission,
  TradingCycleEffects,
} from "./types.js";
import type { TradingEnv } from "./trading-agent.js";
import {
  authorizationWorkflowError,
  reconciliationWorkflowError,
} from "./workflow-errors.js";

const authenticationError = authorizationWorkflowError;
const reconciliationError = (retryable = true): WorkflowError =>
  reconciliationWorkflowError("RECONCILIATION_FAILURE", retryable);

export interface TradingEffectsDependencies {
  readonly configuration: AgentConfiguration;
  readonly env: TradingEnv;
  readonly agentName: string;
  ensureIntervalSchedule(
    intervalSeconds: number,
  ): Promise<{ readonly time: number }>;
  removeIntervalSchedule(): Promise<void>;
  checkpoint(artifacts: CycleArtifacts): Promise<Result<void, WorkflowError>>;
  persistMachine(machine: PersistedTradingMachine): Promise<void>;
  persistOrderIntent(
    cycleId: string,
    intent: OrderIntent,
  ): Promise<Result<void, WorkflowError>>;
  submitPaperOrder(
    intent: OrderIntent,
    marketPrice: number,
    portfolio: PaperPortfolio,
    executedAt: number,
    configuration: AgentConfiguration,
  ): Promise<OrderSubmission>;
  submitLiveOrder(
    settings: CoinbaseExecutionSettings,
    intent: OrderIntent,
    riskDecision: Extract<RiskDecision, { readonly status: "APPROVED" }>,
    authorization: ExecutionAuthorization,
  ): Promise<OrderSubmission>;
  reconcilePaperOrder(
    intent: OrderIntent,
  ): Promise<Result<OrderSubmission, WorkflowError>>;
  reconcileLiveOrder(
    settings: CoinbaseExecutionSettings,
    intent: OrderIntent,
    riskDecision: Extract<RiskDecision, { readonly status: "APPROVED" }>,
    portfolio: PaperPortfolio,
  ): Promise<Result<OrderSubmission, WorkflowError>>;
  submitPerpOrder(
    settings: HyperliquidExecutionSettings,
    intent: OrderIntent,
    riskDecision: Extract<RiskDecision, { readonly status: "APPROVED" }>,
    marketPrice: number,
  ): Promise<OrderSubmission>;
  reconcilePerpOrder(
    settings: HyperliquidExecutionSettings,
    intent: OrderIntent,
  ): Promise<Result<OrderSubmission, WorkflowError>>;
  persistCycle(
    artifacts: CycleArtifacts | null,
    machine: PersistedTradingMachine,
  ): Promise<Result<void, WorkflowError>>;
  loadKnownProtectiveOrderIds(): Result<readonly string[], WorkflowError>;
  getKillContext(): {
    readonly killRequestId: string;
    readonly permissions: ControlPermissions;
  } | null;
  applyKilledAccount(account: CoinbaseAccountSnapshot): void;
}

export const createTradingCycleEffects = (
  deps: TradingEffectsDependencies,
): TradingCycleEffects => {
  const liveSettings =
    deps.configuration.executionMode === "live"
      ? resolveCoinbaseSettings(deps.env)
      : null;
  const perpSettings =
    deps.configuration.executionMode === "perp"
      ? resolveHyperliquidSettings(deps.env)
      : null;
  return {
    reconcileAccount: async (portfolio, observedAt) => {
      if (
        deps.configuration.executionMode === "paper" ||
        deps.configuration.executionMode === "perp"
      ) {
        return ok({
          snapshotId: `paper:${deps.agentName}:${observedAt}`,
          observedAt,
          portfolio,
          accountEquity:
            portfolio.cash +
            portfolio.positionQuantity * portfolio.averagePrice,
          otherExposureNotional: 0,
        });
      }
      if (liveSettings === null || !liveSettings.ok) {
        return err(reconciliationError(false));
      }
      const knownProtectiveOrderIds = deps.loadKnownProtectiveOrderIds();
      if (!knownProtectiveOrderIds.ok) {
        return err(reconciliationError(false));
      }
      return reconcileCoinbaseOwnedAccount(
        liveSettings.value,
        deps.configuration.productId,
        knownProtectiveOrderIds.value,
      );
    },
    fetchMarketData: async (config, triggeredAt) =>
      fetchMarketSnapshot(
        deps.env.MARKET_DATA,
        deps.env.INTERNAL_SERVICE_TOKEN,
        config,
        triggeredAt,
      ),
    ensureSchedule: async (intervalSeconds) => {
      try {
        const schedule = await deps.ensureIntervalSchedule(intervalSeconds);
        return ok({ nextWakeAt: schedule.time });
      } catch {
        return err({
          phase: "schedule",
          code: "SCHEDULE_FAILURE",
          retryable: true,
        });
      }
    },
    checkpoint: async (artifacts) => deps.checkpoint(artifacts),
    persistMachine: async (nextMachine) => deps.persistMachine(nextMachine),
    persistOrderIntent: async (cycleId, intent) =>
      deps.persistOrderIntent(cycleId, intent),
    authorize: async () => {
      if (
        deps.configuration.executionMode === "paper" ||
        deps.configuration.executionMode === "perp"
      ) {
        const issuedAt = Date.now();
        return ok({ issuedAt, expiresAt: issuedAt + 60_000 });
      }
      if (liveSettings === null || !liveSettings.ok) {
        return err(authenticationError());
      }
      return createCoinbaseAuthorization(
        liveSettings.value,
        "POST",
        COINBASE_CREATE_ORDER_PATH,
      );
    },
    submitOrder: async (
      intent,
      riskDecision,
      authorization,
      marketPrice,
      portfolio,
      at,
    ) => {
      if (deps.configuration.executionMode === "paper") {
        return deps.submitPaperOrder(
          intent,
          marketPrice,
          portfolio,
          at,
          deps.configuration,
        );
      }
      if (deps.configuration.executionMode === "perp") {
        if (perpSettings === null || !perpSettings.ok) {
          return {
            status: "REJECTED",
            error: authenticationError(),
          };
        }
        return deps.submitPerpOrder(
          perpSettings.value,
          intent,
          riskDecision,
          marketPrice,
        );
      }
      if (liveSettings === null || !liveSettings.ok) {
        return {
          status: "REJECTED",
          error: authenticationError(),
        };
      }
      return deps.submitLiveOrder(
        liveSettings.value,
        intent,
        riskDecision,
        authorization,
      );
    },
    reconcileOrder: async (intent, riskDecision, portfolio) => {
      if (deps.configuration.executionMode === "paper") {
        return deps.reconcilePaperOrder(intent);
      }
      if (deps.configuration.executionMode === "perp") {
        if (perpSettings === null || !perpSettings.ok) {
          return err(reconciliationError());
        }
        return deps.reconcilePerpOrder(perpSettings.value, intent);
      }
      if (liveSettings === null || !liveSettings.ok) {
        return err(reconciliationError());
      }
      return deps.reconcileLiveOrder(
        liveSettings.value,
        intent,
        riskDecision,
        portfolio,
      );
    },
    cancelCurrentEffect: async (shutdownMode) => {
      try {
        await deps.removeIntervalSchedule();
        if (
          shutdownMode === "kill-switch" &&
          deps.configuration.executionMode === "live"
        ) {
          const killContext = deps.getKillContext();
          if (liveSettings === null || !liveSettings.ok || killContext === null) {
            return err({
              phase: "cancellation",
              code: "CANCELLATION_FAILURE",
              retryable: false,
            });
          }
          const killed = await executeCoinbaseKill(
            liveSettings.value,
            deps.configuration.productId,
            killContext.permissions,
            `kill-${killContext.killRequestId}`,
          );
          if (!killed.ok) {
            return err({ ...killed.error, phase: "cancellation" });
          }
          deps.applyKilledAccount(killed.value);
        }
        return ok(undefined);
      } catch {
        return err({
          phase: "cancellation",
          code: "CANCELLATION_FAILURE",
          retryable: false,
        });
      }
    },
    persistCycle: async (cycleArtifacts, nextMachine) =>
      deps.persistCycle(cycleArtifacts, nextMachine),
  };
};
