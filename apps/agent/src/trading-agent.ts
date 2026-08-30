import { err, ok, type OrderIntent, type Result } from "@dodash/domain";
import { executePaperOrder } from "@dodash/paper-execution";
import type { RiskDecision } from "@dodash/risk";
import {
  assessLiveTradingAgentIdentity,
  type ControlPermissions,
  type TradingCycleEvent,
  type LivePreflightFailureReason,
  type WorkflowError,
} from "@dodash/models";
import { Agent } from "agents";

import {
  admitAgentConfiguration,
  parseAgentConfiguration,
  type AgentConfiguration,
} from "./configuration.js";
import {
  type PerpOrderRequestResult,
  recoverPerpOrders,
  submitPerpOrderIntent,
} from "./hyperliquid-control.js";
import {
  admitHyperliquidPerpAgent,
} from "./configuration.js";
import {
  PERP_ORDERS_SCHEMA,
  createSqlitePerpOrderStore,
  type PerpOrderSqlAdapter,
} from "./hyperliquid-store.js";
import {
  createHyperliquidPerpRunner,
  type HyperliquidPerpRunner,
} from "./hyperliquid-orchestrator.js";
import { toPerpIntent } from "./hyperliquid-control.js";
import {
  derivePerpRiskGate,
  fetchHyperliquidAccountState,
  hyperliquidCoin,
} from "./hyperliquid-execution.js";
import {
  type HyperliquidExecutionSettings,
  resolveHyperliquidSettings,
} from "./hyperliquid-settings.js";
import {
  preflightCoinbaseLive,
  type CoinbaseLivePreflightReport,
} from "./coinbase-preflight.js";
import {
  executeCoinbaseKill,
  executeCoinbaseProtectedSell,
  type CoinbaseProtectedSellCheckpoint,
  type CoinbaseProtectedSellPersistence,
} from "./coinbase-control.js";
import {
  COINBASE_CREATE_ORDER_PATH,
  coinbaseOrderPath,
  confirmCoinbaseProtectiveOrder,
  createCoinbaseAuthorization,
  getCoinbaseOrder,
  resolveCoinbaseSettings,
  submitCoinbaseOrder,
  type CoinbaseExecutionSettings,
  type CoinbaseProtectionPlan,
} from "./coinbase-execution.js";
import { createTradingCycleEffects } from "./trading-effects.js";
import { runTradingCycle } from "./interpreter.js";
import { createTradingMachineSession, type PersistedTradingMachine } from "./machine-session.js";
import {
  INITIAL_AGENT_STATE,
  machineIsEnabled,
  resolveCycleDailyRiskCompletion,
  resolveCycleDailyRiskStart,
  resolveCycleInvocation,
  resolveLiveStartContinuity,
  type CycleSummary,
  type TradingAgentState,
} from "./state.js";
import {
  emitTradingTelemetry,
  type TradingTelemetrySink,
} from "./telemetry.js";
import type {
  CycleArtifacts,
  ExecutionAuthorization,
  OrderSubmission,
  TradingCycleEffects,
} from "./types.js";
import {
  executionWorkflowError,
  reconciliationWorkflowError,
  storageWorkflowError,
} from "./workflow-errors.js";

export interface TradingEnv extends Env {
  readonly INTERNAL_SERVICE_TOKEN: string;
  readonly CONTROL_API_TOKEN: string;
  readonly LIVE_TRADING_ENABLED?: string;
  readonly COINBASE_API_BASE_URL?: string;
  readonly COINBASE_API_KEY_ID?: string;
  readonly COINBASE_API_PRIVATE_KEY?: string;
  readonly COINBASE_PORTFOLIO_ID?: string;
  readonly HYPERLIQUID_PERP_TRADING_ENABLED?: string;
  readonly HYPERLIQUID_AGENT_PRIVATE_KEY?: string;
  readonly HYPERLIQUID_WALLET_ADDRESS?: string;
  readonly HYPERLIQUID_TESTNET?: string;
  readonly HYPERLIQUID_API_BASE_URL?: string;
  readonly TRADING_TELEMETRY?: TradingTelemetrySink;
}

export type AgentCommandResult =
  | { readonly ok: true; readonly state: TradingAgentState }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "INVALID_CONFIGURATION"
          | "INVALID_STATE"
          | "LIVE_PRODUCT_NOT_ALLOWED"
          | "LIVE_POLICY_MISMATCH"
          | "LIVE_AGENT_NAME_MISMATCH"
          | "LIVE_EXECUTION_UNAVAILABLE"
          | "NOT_CONFIGURED"
          | "PERP_PRODUCT_NOT_ALLOWED"
          | "PERP_POLICY_MISMATCH"
          | "PERP_ADMISSION_REQUIRED"
          | "HYPERLIQUID_EXECUTION_UNAVAILABLE";
      };
    };

export type LivePreflightCommandResult =
  | { readonly ok: true; readonly report: CoinbaseLivePreflightReport }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "CONTROL_PERMISSION_REQUIRED"
          | "INVALID_CONFIGURATION"
          | "LIVE_PRODUCT_NOT_ALLOWED"
          | "LIVE_POLICY_MISMATCH"
          | "LIVE_AGENT_NAME_MISMATCH"
          | "PREFLIGHT_UNAVAILABLE"
          | LivePreflightFailureReason;
      };
      readonly report?: CoinbaseLivePreflightReport;
    };

const storageError = storageWorkflowError;
const executionError = executionWorkflowError;
const reconciliationError = (retryable = true): WorkflowError =>
  reconciliationWorkflowError("RECONCILIATION_FAILURE", retryable);

type ApprovedRiskDecision = Extract<
  RiskDecision,
  { readonly status: "APPROVED" }
>;

const protectionFromRisk = (
  riskDecision: ApprovedRiskDecision,
): CoinbaseProtectionPlan =>
  Object.freeze({
    stopLossPrice: riskDecision.stopLossPrice,
    takeProfitPrice: riskDecision.takeProfitPrice,
  });

const parseJson = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export class TradingAgent extends Agent<TradingEnv, TradingAgentState> {
  override initialState = INITIAL_AGENT_STATE;

  private ensureTradingPersistenceSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS dodash_cycles (
        cycle_id TEXT PRIMARY KEY,
        triggered_at INTEGER NOT NULL,
        completed_at INTEGER,
        phase TEXT NOT NULL,
        outcome TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        error_json TEXT,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS dodash_orders (
        client_order_id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL,
        exchange_order_id TEXT,
        execution_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS dodash_sell_workflows (
        client_order_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.ctx.storage.sql.exec(PERP_ORDERS_SCHEMA);
  }

  override async onStart(): Promise<void> {
    this.ensureTradingPersistenceSchema();

    if (this.state.enabled && this.state.configuration !== null) {
      await this.ensureIntervalSchedule(this.state.configuration.intervalSeconds);
    }
  }

  private perpSqlAdapter(): PerpOrderSqlAdapter {
    const raw = this.ctx.storage.sql;
    return {
      run: (query, params) => {
        raw.exec(query, ...params);
      },
      all: <T>(query: string, params: readonly unknown[]): readonly T[] =>
        raw
          .exec<Record<string, string | number | null>>(query, ...params)
          .toArray() as T[],
    };
  }

  async submitPerpOrderIntent(
    input: unknown,
    permissions: ControlPermissions,
  ): Promise<PerpOrderRequestResult> {
    this.ensureTradingPersistenceSchema();
    return submitPerpOrderIntent({
      input,
      permissions,
      settingsInput: this.env,
      sql: this.perpSqlAdapter(),
      now: () => Date.now(),
    });
  }

  private async recoverPendingPerpOrders(): Promise<void> {
    try {
      const report = await recoverPerpOrders({
        settingsInput: this.env,
        sql: this.perpSqlAdapter(),
        now: () => Date.now(),
      });
      if (!report.unavailable && report.unresolved > 0) {
        console.log(
          JSON.stringify({ type: "PERP_RECOVERY", ...report }),
        );
      }
    } catch (error) {
      // La reprise repartira au prochain tick : aucune resoumission n'est
      // jamais déclenchée par un échec de réconciliation.
      console.error(
        "PERP_RECOVERY_FAILED",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }

  override validateStateChange(
    _nextState: TradingAgentState,
    source: Parameters<Agent<TradingEnv, TradingAgentState>["validateStateChange"]>[1],
  ): void {
    if (source !== "server") {
      throw new Error("Client-originated trading state changes are forbidden");
    }
  }

  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  async startAgent(
    configurationInput: unknown,
    permissions: ControlPermissions,
  ): Promise<AgentCommandResult> {
    this.ensureTradingPersistenceSchema();
    const configuration = parseAgentConfiguration(configurationInput);
    if (!configuration.ok) {
      return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
    }

    const currentPhase = this.state.machine?.value ?? "stopped";
    if (currentPhase !== "stopped") {
      return { ok: false, error: { code: "INVALID_STATE" } };
    }

    const admission = admitAgentConfiguration(configuration.value);
    if (configuration.value.executionMode === "perp") {
      const perpAdmission = admitHyperliquidPerpAgent(configuration.value);
      if (perpAdmission.status === "REJECTED") {
        return { ok: false, error: { code: perpAdmission.reasonCode } };
      }
      if (!resolveHyperliquidSettings(this.env).ok) {
        return { ok: false, error: { code: "HYPERLIQUID_EXECUTION_UNAVAILABLE" } };
      }
    } else if (admission.status === "REJECTED") {
      return { ok: false, error: { code: admission.reasonCode } };
    }
    if (configuration.value.executionMode === "live") {
      const identityAdmission = assessLiveTradingAgentIdentity(
        configuration.value.productId,
        this.name,
      );
      if (identityAdmission.status === "REJECTED") {
        return { ok: false, error: { code: identityAdmission.reasonCode } };
      }
    }

    if (
      configuration.value.executionMode === "live" &&
      !resolveCoinbaseSettings(this.env).ok
    ) {
      return { ok: false, error: { code: "LIVE_EXECUTION_UNAVAILABLE" } };
    }

    if (
      this.state.schedule !== null &&
      this.state.schedule.intervalSeconds !== configuration.value.intervalSeconds
    ) {
      await this.cancelSchedule(this.state.schedule.id);
    }

    const continuity = resolveLiveStartContinuity(
      this.state,
      configuration.value,
    );

    const session = createTradingMachineSession({
      agentId: this.name,
      strategyIds: configuration.value.strategyIds,
      maxMarketStalenessMs: configuration.value.maxMarketStalenessMs,
      lastDecisionCandleClosedAt:
        continuity.lastDecisionCandleClosedAt,
    });
    session.send({ type: "START_REQUESTED", permissions });
    const machine = session.record;
    session.stop();

    this.setState({
      ...INITIAL_AGENT_STATE,
      ...continuity,
      configuration: configuration.value,
      machine,
      enabled: machineIsEnabled(machine.value),
      schedule:
        this.state.schedule?.intervalSeconds === configuration.value.intervalSeconds
          ? this.state.schedule
          : null,
      updatedAt: Date.now(),
    });

    await this.runCurrent(false);
    return { ok: true, state: this.state };
  }

  async preflightLive(
    configurationInput: unknown,
    permissions: ControlPermissions,
  ): Promise<LivePreflightCommandResult> {
    const startedAt = Date.now();
    if (!permissions.canControl) {
      return { ok: false, error: { code: "CONTROL_PERMISSION_REQUIRED" } };
    }
    this.ensureTradingPersistenceSchema();
    const configuration = parseAgentConfiguration(configurationInput);
    if (!configuration.ok || configuration.value.executionMode !== "live") {
      return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
    }
    const admission = admitAgentConfiguration(configuration.value);
    if (admission.status === "REJECTED") {
      return { ok: false, error: { code: admission.reasonCode } };
    }
    const identityAdmission = assessLiveTradingAgentIdentity(
      configuration.value.productId,
      this.name,
    );
    if (identityAdmission.status === "REJECTED") {
      return { ok: false, error: { code: identityAdmission.reasonCode } };
    }
    const protections = this.loadKnownProtectiveOrderIds();
    if (!protections.ok) {
      return { ok: false, error: { code: "PREFLIGHT_UNAVAILABLE" } };
    }
    const report = await preflightCoinbaseLive(
      this.env,
      configuration.value.productId,
      protections.value,
    );
    emitTradingTelemetry(this.env.TRADING_TELEMETRY, {
      schemaVersion: 1,
      type: "preflight.completed",
      timestamp: Date.now(),
      agentId: this.name,
      productId: configuration.value.productId,
      executionMode: "live",
      phase: "preflight",
      outcome: report.assessment.status,
      errorCode:
        report.assessment.status === "REJECTED"
          ? report.assessment.reasonCode
          : null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      dailyPnl: null,
      accountEquity: null,
      positionQuantity: null,
      otherExposureNotional: null,
      executionObserved: false,
      openOrderCount: report.openOrderCount,
    });
    return report.assessment.status === "APPROVED"
      ? { ok: true, report }
      : {
          ok: false,
          error: { code: report.assessment.reasonCode },
          report,
        };
  }

  async stopAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    return this.control({ type: "STOP_REQUESTED", permissions });
  }

  async killAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    return this.control({
      type: "KILL_SWITCH_ENGAGED",
      permissions,
      controlId: crypto.randomUUID(),
    });
  }

  async resetAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    this.ensureTradingPersistenceSchema();
    if (this.state.machine === null || this.state.configuration === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    const session = createTradingMachineSession(
      {
        agentId: this.name,
        strategyIds: this.state.configuration.strategyIds,
        maxMarketStalenessMs:
          this.state.configuration.maxMarketStalenessMs,
      },
      this.state.machine,
    );
    session.send({ type: "RESET", permissions });
    const machine = session.record;
    session.stop();
    await this.persistMachine(machine);
    return { ok: true, state: this.state };
  }

  async runNow(): Promise<AgentCommandResult> {
    this.ensureTradingPersistenceSchema();
    if (this.state.configuration === null || this.state.machine === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    await this.runCurrent(true);
    return { ok: true, state: this.state };
  }

  async scheduledTick(): Promise<void> {
    this.ensureTradingPersistenceSchema();
    await this.recoverPendingPerpOrders();
    if (!this.state.enabled) return;
    await this.runCurrent(true);
  }

  getAgentState(): TradingAgentState {
    return this.state;
  }

  listRecentCycles(limit = 50): readonly Record<string, unknown>[] {
    this.ensureTradingPersistenceSchema();
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.sql<Record<string, string | number | null>>`
      SELECT cycle_id, triggered_at, completed_at, phase, outcome,
             error_json, updated_at
      FROM dodash_cycles
      ORDER BY triggered_at DESC
      LIMIT ${boundedLimit}
    `;
  }

  private async control(event: TradingCycleEvent): Promise<AgentCommandResult> {
    const startedAt = Date.now();
    this.ensureTradingPersistenceSchema();
    if (this.state.machine === null || this.state.configuration === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    const session = createTradingMachineSession(
      {
        agentId: this.name,
        strategyIds: this.state.configuration.strategyIds,
        maxMarketStalenessMs:
          this.state.configuration.maxMarketStalenessMs,
      },
      this.state.machine,
    );
    const resumeCycleId =
      session.phase === "waiting" ||
      session.phase === "scheduling" ||
      session.phase === "stopped"
        ? null
        : session.context.cycleId;
    session.send(event);
    const machine = session.record;
    session.stop();
    await this.persistMachine(machine);
    await this.runCurrent(false, resumeCycleId);
    emitTradingTelemetry(this.env.TRADING_TELEMETRY, {
      schemaVersion: 1,
      type: "control.completed",
      timestamp: Date.now(),
      agentId: this.name,
      productId: this.state.configuration.productId,
      executionMode: this.state.configuration.executionMode,
      phase: this.state.machine?.value ?? machine.value,
      outcome: this.state.machine?.context.outcome ?? machine.context.outcome,
      errorCode:
        this.state.machine?.context.lastError?.code ??
        machine.context.lastError?.code ??
        null,
      latencyMs: Math.max(0, Date.now() - startedAt),
      dailyPnl: this.state.dailyPnl,
      accountEquity: null,
      positionQuantity: this.state.portfolio.positionQuantity,
      otherExposureNotional: null,
      executionObserved: false,
      openOrderCount: null,
    });
    return { ok: true, state: this.state };
  }

  private async runCurrent(
    triggerAlarm: boolean,
    resumeCycleIdOverride?: string | null,
  ): Promise<void> {
    const startedAt = Date.now();
    const configuration = this.state.configuration;
    const machine = this.state.machine;
    if (configuration === null || machine === null) return;

    const identity = resolveCycleInvocation(
      machine,
      triggerAlarm,
      Date.now(),
      crypto.randomUUID(),
      resumeCycleIdOverride,
    );
    const artifacts =
      identity.loadCycleId === null
        ? null
        : this.loadArtifacts(identity.loadCycleId);
    const knownPrice = this.state.lastCycle?.marketPrice ?? null;
    const startingEquity =
      this.state.portfolio.cash +
      this.state.portfolio.positionQuantity *
        (knownPrice ?? this.state.portfolio.averagePrice);
    const dailyRiskAtStart = resolveCycleDailyRiskStart(
      configuration.executionMode,
      this.state.dailyRiskWindow ?? null,
      this.state.dailyPnl,
      identity.triggeredAt,
      startingEquity,
    );
    const result = await runTradingCycle({
      agentId: this.name,
      configuration,
      machine,
      artifacts,
      previousIndicators: this.state.previousIndicators,
      portfolio: this.state.portfolio,
      dailyPnl: dailyRiskAtStart.dailyPnl,
      dailyRiskWindow: dailyRiskAtStart.window,
      lastTradeAt: this.state.lastTradeAt,
      triggeredAt: identity.triggeredAt,
      cycleId: identity.cycleId,
      triggerAlarm,
      effects: this.createEffects(configuration),
    });

    const lastPrice = result.artifacts?.market?.candles.at(-1)?.close ?? null;
    const equity =
      lastPrice === null
        ? startingEquity
        : result.portfolio.cash + result.portfolio.positionQuantity * lastPrice;
    const dailyRisk = resolveCycleDailyRiskCompletion(
      configuration.executionMode,
      result.dailyRiskWindow,
      result.dailyPnl,
      identity.triggeredAt,
      equity,
    );
    const executed = result.artifacts?.execution !== undefined;
    const lastCycle = this.toCycleSummary(result.artifacts, result.machine);
    this.setState({
      ...this.state,
      machine: result.machine,
      enabled: machineIsEnabled(result.machine.value),
      portfolio: result.portfolio,
      dailyRiskWindow: dailyRisk.window,
      dailyPnl: dailyRisk.dailyPnl,
      lastTradeAt: executed
        ? result.artifacts?.triggeredAt ?? this.state.lastTradeAt
        : this.state.lastTradeAt,
      previousIndicators: result.previousIndicators,
      lastCycle: lastCycle ?? this.state.lastCycle,
      updatedAt: Date.now(),
    });

    if (result.artifacts !== null) {
      emitTradingTelemetry(this.env.TRADING_TELEMETRY, {
        schemaVersion: 1,
        type: "cycle.completed",
        timestamp: Date.now(),
        agentId: this.name,
        productId: configuration.productId,
        executionMode: configuration.executionMode,
        phase: result.machine.value,
        outcome: result.machine.context.outcome,
        errorCode: result.machine.context.lastError?.code ?? null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        dailyPnl: dailyRisk.dailyPnl,
        accountEquity: result.accountEquity,
        positionQuantity: result.portfolio.positionQuantity,
        otherExposureNotional: result.otherExposureNotional,
        executionObserved: executed,
        openOrderCount: null,
      });
    }

    if (!machineIsEnabled(result.machine.value)) {
      await this.removeIntervalSchedule();
    }
  }

  private createEffects(configuration: AgentConfiguration): TradingCycleEffects {
    return createTradingCycleEffects({
      configuration,
      env: this.env,
      agentName: this.name,
      ensureIntervalSchedule: (intervalSeconds) =>
        this.ensureIntervalSchedule(intervalSeconds),
      removeIntervalSchedule: () => this.removeIntervalSchedule(),
      checkpoint: (artifacts) => this.checkpoint(artifacts),
      persistMachine: (nextMachine) => this.persistMachine(nextMachine),
      persistOrderIntent: (cycleId, intent) =>
        this.persistOrderIntent(cycleId, intent),
      submitPaperOrder: (intent, marketPrice, portfolio, executedAt, config) =>
        this.submitPaperOrder(intent, marketPrice, portfolio, executedAt, config),
      submitLiveOrder: (settings, intent, riskDecision, authorization) =>
        this.submitLiveOrder(settings, intent, riskDecision, authorization),
      submitPerpOrder: (settings, intent, riskDecision, marketPrice) =>
        this.submitPerpSignalOrder(settings, intent, riskDecision, marketPrice),
      reconcilePaperOrder: (intent) => this.reconcilePaperOrder(intent),
      reconcileLiveOrder: (settings, intent, riskDecision, portfolio) =>
        this.reconcileLiveOrder(settings, intent, riskDecision, portfolio),
      reconcilePerpOrder: (settings, intent) =>
        this.reconcilePerpSignalOrder(settings, intent),
      persistCycle: (cycleArtifacts, nextMachine) =>
        this.persistCycle(cycleArtifacts, nextMachine),
      loadKnownProtectiveOrderIds: () => this.loadKnownProtectiveOrderIds(),
      getKillContext: () => {
        const context = this.state.machine?.context;
        if (context?.killRequestId == null) {
          return null;
        }
        return {
          killRequestId: context.killRequestId,
          permissions: context.permissions,
        };
      },
      applyKilledAccount: (account) => {
        const dailyRisk = resolveCycleDailyRiskCompletion(
          "live",
          this.state.dailyRiskWindow,
          this.state.dailyPnl,
          account.observedAt,
          account.accountEquity,
        );
        this.setState({
          ...this.state,
          portfolio: account.portfolio,
          dailyRiskWindow: dailyRisk.window,
          dailyPnl: dailyRisk.dailyPnl,
          updatedAt: Date.now(),
        });
      },
    });
  }

  private async ensureIntervalSchedule(intervalSeconds: number) {
    if (
      this.state.schedule !== null &&
      this.state.schedule.intervalSeconds !== intervalSeconds
    ) {
      await this.cancelSchedule(this.state.schedule.id);
    }
    const schedule = await this.scheduleEvery(intervalSeconds, "scheduledTick");
    this.setState({
      ...this.state,
      schedule: { id: schedule.id, intervalSeconds },
      updatedAt: Date.now(),
    });
    return schedule;
  }

  private async removeIntervalSchedule(): Promise<void> {
    if (this.state.schedule === null) return;
    await this.cancelSchedule(this.state.schedule.id);
    this.setState({
      ...this.state,
      schedule: null,
      updatedAt: Date.now(),
    });
  }

  private async persistMachine(machine: PersistedTradingMachine): Promise<void> {
    this.setState({
      ...this.state,
      machine,
      enabled: machineIsEnabled(machine.value),
      updatedAt: Date.now(),
    });
  }

  private async checkpoint(
    artifacts: CycleArtifacts,
  ): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<WorkflowError>>> {
    try {
      const now = Date.now();
      this.sql`
        INSERT INTO dodash_cycles (
          cycle_id, triggered_at, completed_at, phase, outcome,
          artifacts_json, error_json, updated_at
        ) VALUES (
          ${artifacts.cycleId}, ${artifacts.triggeredAt}, NULL,
          ${this.state.machine?.value ?? "unknown"},
          ${this.state.machine?.context.outcome ?? "RUNNING"},
          ${JSON.stringify(artifacts)}, NULL, ${now}
        )
        ON CONFLICT(cycle_id) DO UPDATE SET
          phase = excluded.phase,
          outcome = excluded.outcome,
          artifacts_json = excluded.artifacts_json,
          updated_at = excluded.updated_at
      `;
      return ok(undefined);
    } catch {
      return err(storageError());
    }
  }

  private loadArtifacts(cycleId: string): CycleArtifacts | null {
    const row = this.sql<{ artifacts_json: string }>`
      SELECT artifacts_json FROM dodash_cycles WHERE cycle_id = ${cycleId} LIMIT 1
    `.at(0);
    return row === undefined ? null : parseJson<CycleArtifacts>(row.artifacts_json);
  }

  private async persistOrderIntent(
    cycleId: string,
    intent: OrderIntent,
  ): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<WorkflowError>>> {
    try {
      const now = Date.now();
      const existing = this.sql<{ intent_json: string }>`
        SELECT intent_json FROM dodash_orders
        WHERE client_order_id = ${intent.clientOrderId}
        LIMIT 1
      `.at(0);
      const serialized = JSON.stringify(intent);
      if (existing !== undefined && existing.intent_json !== serialized) {
        return err(storageError(false));
      }
      this.sql`
        INSERT INTO dodash_orders (
          client_order_id, cycle_id, intent_json, status,
          exchange_order_id, execution_json, created_at, updated_at
        ) VALUES (
          ${intent.clientOrderId}, ${cycleId}, ${serialized}, 'INTENT_PERSISTED',
          NULL, NULL, ${now}, ${now}
        )
        ON CONFLICT(client_order_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `;
      return ok(undefined);
    } catch {
      return err(storageError());
    }
  }

  private async submitPaperOrder(
    intent: OrderIntent,
    marketPrice: number,
    portfolio: TradingAgentState["portfolio"],
    executedAt: number,
    configuration: AgentConfiguration,
  ): Promise<OrderSubmission> {
    const reconciled = await this.reconcilePaperOrder(intent);
    if (reconciled.ok && reconciled.value.status === "CONFIRMED") {
      return reconciled.value;
    }

    const execution = executePaperOrder(
      portfolio,
      intent,
      marketPrice,
      executedAt,
      configuration.broker,
    );
    if (!execution.ok) {
      return {
        status: "REJECTED",
        error: executionError("ORDER_REJECTED", false),
      };
    }
    const submission: OrderSubmission = {
      status: "CONFIRMED",
      exchangeOrderId: execution.value.trade.fill.exchangeOrderId,
      portfolio: execution.value.portfolio,
      fill: execution.value.trade.fill,
    };

    try {
      const now = Date.now();
      this.sql`
        UPDATE dodash_orders SET
          status = 'CONFIRMED',
          exchange_order_id = ${submission.exchangeOrderId},
          execution_json = ${JSON.stringify(submission)},
          updated_at = ${now}
        WHERE client_order_id = ${intent.clientOrderId}
      `;
      return submission;
    } catch {
      return {
        status: "UNKNOWN",
        error: executionError("ORDER_OUTCOME_UNKNOWN", true),
      };
    }
  }

  private async reconcilePaperOrder(
    intent: OrderIntent,
  ): Promise<
    | ReturnType<typeof ok<OrderSubmission>>
    | ReturnType<typeof err<WorkflowError>>
  > {
    try {
      const row = this.sql<{ status: string; execution_json: string | null }>`
        SELECT status, execution_json FROM dodash_orders
        WHERE client_order_id = ${intent.clientOrderId}
        LIMIT 1
      `.at(0);
      if (row?.status === "CONFIRMED" && row.execution_json !== null) {
        const submission = parseJson<OrderSubmission>(row.execution_json);
        if (submission !== null && submission.status === "CONFIRMED") {
          return ok(submission);
        }
      }
      return ok({
        status: "REJECTED",
        error: executionError("ORDER_REJECTED", false),
      });
    } catch {
      return err({
        phase: "reconciliation",
        code: "RECONCILIATION_FAILURE",
        retryable: true,
      });
    }
  }

  private loadExchangeOrderId(clientOrderId: string): string | null {
    const row = this.sql<{ exchange_order_id: string | null }>`
      SELECT exchange_order_id FROM dodash_orders
      WHERE client_order_id = ${clientOrderId}
      LIMIT 1
    `.at(0);
    return row?.exchange_order_id ?? null;
  }

  private loadKnownProtectiveOrderIds(): Result<readonly string[], WorkflowError> {
    try {
      const rows = this.sql<{ execution_json: string }>`
        SELECT execution_json FROM dodash_orders
        WHERE execution_json IS NOT NULL
      `;
      const orderIds = new Set<string>();
      for (const row of rows) {
        const submission = parseJson<OrderSubmission>(row.execution_json);
        if (
          submission !== null &&
          "protectiveOrderId" in submission &&
          typeof submission.protectiveOrderId === "string" &&
          submission.protectiveOrderId.length > 0
        ) {
          orderIds.add(submission.protectiveOrderId);
        }
      }
      return ok(Object.freeze([...orderIds]));
    } catch {
      return err(storageError(false));
    }
  }

  private persistLiveOrderResult(
    intent: OrderIntent,
    submission: OrderSubmission,
  ): Result<void, WorkflowError> {
    try {
      const exchangeOrderId =
        "exchangeOrderId" in submission
          ? submission.exchangeOrderId ?? null
          : null;
      const status =
        submission.status === "CONFIRMED"
          ? "CONFIRMED"
          : submission.status === "PROTECTION_FAILED"
            ? "PROTECTION_FAILED"
          : submission.status === "TERMINAL_FAILED"
            ? "TERMINAL_FAILED"
          : submission.status === "NO_SELL_NEEDED"
            ? "NO_SELL_NEEDED"
          : submission.status === "REJECTED"
            ? "REJECTED"
            : exchangeOrderId === null
              ? "OUTCOME_UNKNOWN"
              : "ACKNOWLEDGED";
      const executionJson =
        submission.status === "UNKNOWN" ? null : JSON.stringify(submission);
      const now = Date.now();
      this.sql`
        UPDATE dodash_orders SET
          status = ${status},
          exchange_order_id = COALESCE(${exchangeOrderId}, exchange_order_id),
          execution_json = ${executionJson},
          updated_at = ${now}
        WHERE client_order_id = ${intent.clientOrderId}
      `;
      return ok(undefined);
    } catch {
      return err(storageError());
    }
  }

  private loadProtectedSellCheckpoint(
    clientOrderId: string,
  ): Result<CoinbaseProtectedSellCheckpoint | null, WorkflowError> {
    try {
      const row = this.sql<{ checkpoint_json: string }>`
        SELECT checkpoint_json FROM dodash_sell_workflows
        WHERE client_order_id = ${clientOrderId}
        LIMIT 1
      `.at(0);
      if (row === undefined) return ok(null);
      const checkpoint = parseJson<CoinbaseProtectedSellCheckpoint>(
        row.checkpoint_json,
      );
      return checkpoint === null ? err(storageError(false)) : ok(checkpoint);
    } catch {
      return err(storageError(false));
    }
  }

  private protectedSellPersistence(
    intent: OrderIntent,
  ): Result<CoinbaseProtectedSellPersistence, WorkflowError> {
    const restored = this.loadProtectedSellCheckpoint(intent.clientOrderId);
    if (!restored.ok) return restored;
    return ok({
      restored: restored.value,
      persist: async (checkpoint) => {
        try {
          const now = Date.now();
          this.sql`
            INSERT INTO dodash_sell_workflows (
              client_order_id, checkpoint_json, updated_at
            ) VALUES (
              ${intent.clientOrderId}, ${JSON.stringify(checkpoint)}, ${now}
            )
            ON CONFLICT(client_order_id) DO UPDATE SET
              checkpoint_json = excluded.checkpoint_json,
              updated_at = excluded.updated_at
          `;
          return ok(undefined);
        } catch {
          return err(storageError());
        }
      },
    });
  }

  private async submitLiveOrder(
    settings: CoinbaseExecutionSettings,
    intent: OrderIntent,
    riskDecision: ApprovedRiskDecision,
    authorization: ExecutionAuthorization,
  ): Promise<OrderSubmission> {
    const protection = protectionFromRisk(riskDecision);
    let submission: OrderSubmission;
    if (intent.side === "SELL") {
      const protectiveOrderIds = this.loadKnownProtectiveOrderIds();
      if (!protectiveOrderIds.ok) {
        return {
          status: "TERMINAL_FAILED",
          exchangeOrderId: null,
          fill: null,
          error: protectiveOrderIds.error,
        };
      }
      const persistence = this.protectedSellPersistence(intent);
      if (!persistence.ok) {
        return {
          status: "TERMINAL_FAILED",
          exchangeOrderId: null,
          fill: null,
          error: persistence.error,
        };
      }
      submission = await executeCoinbaseProtectedSell(
        settings,
        intent,
        this.state.machine?.context.permissions ?? {
          canControl: false,
          canTrade: false,
        },
        protectiveOrderIds.value,
        {
          stopLossBps: this.state.configuration?.risk.stopLossBps ?? 0,
          takeProfitBps: this.state.configuration?.risk.takeProfitBps ?? 0,
        },
        {},
        persistence.value,
      );
    } else {
      submission = await submitCoinbaseOrder(
        settings,
        intent,
        authorization,
        {},
        protection,
      );
    }
    const persisted = this.persistLiveOrderResult(intent, submission);
    if (persisted.ok || submission.status !== "UNKNOWN") return submission;
    return {
      status: "UNKNOWN",
      error: executionError("ORDER_OUTCOME_UNKNOWN", true),
    };
  }

  private perpRunner(
    settings: HyperliquidExecutionSettings,
  ): HyperliquidPerpRunner {
    return createHyperliquidPerpRunner({
      settings,
      store: createSqlitePerpOrderStore(this.perpSqlAdapter()),
      dependencies: { now: () => Date.now() },
    });
  }

  private async submitPerpSignalOrder(
    settings: HyperliquidExecutionSettings,
    intent: OrderIntent,
    _riskDecision: ApprovedRiskDecision,
    marketPrice: number,
  ): Promise<OrderSubmission> {
    const portfolio = this.state.portfolio;
    const perpIntent = toPerpIntent({
      intent: {
        productId: intent.productId,
        side: intent.side,
        quantity: intent.quantity,
      },
      markPrice: marketPrice,
    });
    if (perpIntent === null) {
      return {
        status: "REJECTED",
        error: executionWorkflowError("ORDER_REJECTED", false),
      };
    }
    const account = await fetchHyperliquidAccountState(settings);
    if (account === null) {
      return { status: "REJECTED", error: executionWorkflowError("ORDER_REJECTED", false) };
    }
    const gate = derivePerpRiskGate({
      snapshot: account,
      coin: "BTC" === hyperliquidCoin(perpIntent.productId) ? "BTC" : "ETH",
      markPrice: marketPrice,
      dailyPnl: this.state.dailyPnl,
    });
    const runner = this.perpRunner(settings);
    const result = await runner.runOrder({
      intent: perpIntent,
      gate,
      clientOrderId: intent.clientOrderId,
    });
    if (result.status === "SETTLED" && result.outcome === "ACCEPTED") {
      return {
        status: "CONFIRMED",
        exchangeOrderId: result.clientOrderId,
        portfolio,
        fill: null,
      };
    }
    if (result.status === "SETTLED" && result.outcome === "REJECTED") {
      return {
        status: "REJECTED",
        error: executionWorkflowError("ORDER_REJECTED", false),
      };
    }
    if (result.status === "REFUSED") {
      return {
        status: "REJECTED",
        error: executionWorkflowError("ORDER_REJECTED", false),
      };
    }
    return {
      status: "UNKNOWN",
      error: executionWorkflowError("ORDER_OUTCOME_UNKNOWN", true),
    };
  }

  private async reconcilePerpSignalOrder(
    settings: HyperliquidExecutionSettings,
    intent: OrderIntent,
  ): Promise<Result<OrderSubmission, WorkflowError>> {
    const runner = this.perpRunner(settings);
    const report = await runner.recoverPending();
    void report;
    return ok({
      status: "CONFIRMED",
      exchangeOrderId: intent.clientOrderId,
      portfolio: this.state.portfolio,
      fill: null,
    } satisfies OrderSubmission);
  }

  private async reconcileLiveOrder(
    settings: CoinbaseExecutionSettings,
    intent: OrderIntent,
    riskDecision: ApprovedRiskDecision,
    portfolio: TradingAgentState["portfolio"],
  ): Promise<Result<OrderSubmission, WorkflowError>> {
    const protection = protectionFromRisk(riskDecision);
    if (intent.side === "SELL") {
      const protectiveOrderIds = this.loadKnownProtectiveOrderIds();
      if (!protectiveOrderIds.ok) return protectiveOrderIds;
      const persistence = this.protectedSellPersistence(intent);
      if (!persistence.ok) return persistence;
      const submission = await executeCoinbaseProtectedSell(
        settings,
        intent,
        this.state.machine?.context.permissions ?? {
          canControl: false,
          canTrade: false,
        },
        protectiveOrderIds.value,
        {
          stopLossBps: this.state.configuration?.risk.stopLossBps ?? 0,
          takeProfitBps: this.state.configuration?.risk.takeProfitBps ?? 0,
        },
        {},
        persistence.value,
      );
      const persisted = this.persistLiveOrderResult(intent, submission);
      return persisted.ok ? ok(submission) : err(reconciliationError());
    }
    let exchangeOrderId = this.loadExchangeOrderId(intent.clientOrderId);
    if (exchangeOrderId === null) {
      const replayAuthorization = createCoinbaseAuthorization(
        settings,
        "POST",
        COINBASE_CREATE_ORDER_PATH,
      );
      if (!replayAuthorization.ok) return err(reconciliationError(false));

      const replay = await submitCoinbaseOrder(
        settings,
        intent,
        replayAuthorization.value,
        {},
        intent.side === "BUY" ? protection : undefined,
      );
      if (replay.status === "REJECTED") {
        const persisted = this.persistLiveOrderResult(intent, replay);
        return persisted.ok ? ok(replay) : err(reconciliationError());
      }
      if (replay.status === "CONFIRMED") {
        const persisted = this.persistLiveOrderResult(intent, replay);
        return persisted.ok ? ok(replay) : err(reconciliationError());
      }
      if (replay.status !== "UNKNOWN") return err(reconciliationError(false));
      exchangeOrderId = replay.exchangeOrderId ?? null;
      if (exchangeOrderId === null) return err(reconciliationError());
      if (!this.persistLiveOrderResult(intent, replay).ok) {
        return err(reconciliationError());
      }
    }

    const path = coinbaseOrderPath(exchangeOrderId);
    const lookupAuthorization = createCoinbaseAuthorization(
      settings,
      "GET",
      path,
    );
    if (!lookupAuthorization.ok) return err(reconciliationError(false));
    const reconciled = await getCoinbaseOrder(
      settings,
      intent,
      exchangeOrderId,
      lookupAuthorization.value,
      portfolio,
      {},
      intent.side === "BUY" ? protection : undefined,
    );
    if (!reconciled.ok) return reconciled;
    if (
      intent.side === "BUY" &&
      reconciled.value.status === "CONFIRMED"
    ) {
      const protectiveOrderId = reconciled.value.protectiveOrderId;
      if (protectiveOrderId === undefined) {
        return err(reconciliationError(false));
      }
      const confirmedProtection =
        reconciled.value.fill === null
          ? err({
              phase: "reconciliation" as const,
              code: "INVALID_RESPONSE" as const,
              retryable: false,
            })
          : await confirmCoinbaseProtectiveOrder(
              settings,
              intent.productId,
              protectiveOrderId,
              protection,
              {},
              reconciled.value.fill.quantity,
            );
      if (!confirmedProtection.ok) {
        const killed = await executeCoinbaseKill(
          settings,
          intent.productId,
          { canControl: true, canTrade: true },
          `protection-${intent.clientOrderId}`,
        );
        if (!killed.ok) {
          return err({ ...killed.error, phase: "reconciliation" });
        }
        const protectionFailure: OrderSubmission = {
          status: "PROTECTION_FAILED",
          exchangeOrderId: reconciled.value.exchangeOrderId,
          portfolio: killed.value.portfolio,
          fill: reconciled.value.fill,
          protectiveOrderId,
          accountEquity: killed.value.accountEquity,
          otherExposureNotional: killed.value.otherExposureNotional,
          observedAt: killed.value.observedAt,
          error: { ...confirmedProtection.error, retryable: false },
        };
        if (!this.persistLiveOrderResult(intent, protectionFailure).ok) {
          return err(reconciliationError());
        }
        return ok(protectionFailure);
      }
    }
    if (!this.persistLiveOrderResult(intent, reconciled.value).ok) {
      return err(reconciliationError());
    }
    return reconciled;
  }

  private async persistCycle(
    artifacts: CycleArtifacts | null,
    machine: PersistedTradingMachine,
  ): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<WorkflowError>>> {
    if (artifacts === null) return ok(undefined);
    try {
      const now = Date.now();
      this.sql`
        INSERT INTO dodash_cycles (
          cycle_id, triggered_at, completed_at, phase, outcome,
          artifacts_json, error_json, updated_at
        ) VALUES (
          ${artifacts.cycleId}, ${artifacts.triggeredAt}, ${now},
          ${machine.value}, ${machine.context.outcome},
          ${JSON.stringify(artifacts)}, ${
            machine.context.lastError === null
              ? null
              : JSON.stringify(machine.context.lastError)
          },
          ${now}
        )
        ON CONFLICT(cycle_id) DO UPDATE SET
          completed_at = excluded.completed_at,
          phase = excluded.phase,
          outcome = excluded.outcome,
          artifacts_json = excluded.artifacts_json,
          error_json = excluded.error_json,
          updated_at = excluded.updated_at
      `;
      return ok(undefined);
    } catch {
      return err(storageError());
    }
  }

  private toCycleSummary(
    artifacts: CycleArtifacts | null,
    machine: PersistedTradingMachine,
  ): CycleSummary | null {
    if (artifacts === null || machine.context.outcome === "RUNNING") return null;
    return Object.freeze({
      cycleId: artifacts.cycleId,
      triggeredAt: artifacts.triggeredAt,
      completedAt: Date.now(),
      outcome: machine.context.outcome,
      marketPrice: artifacts.market?.candles.at(-1)?.close ?? null,
      signalCount: artifacts.signals?.length ?? 0,
      clientOrderId: artifacts.order?.clientOrderId ?? null,
      exchangeOrderId: artifacts.execution?.exchangeOrderId ?? null,
      error: machine.context.lastError,
    });
  }
}
