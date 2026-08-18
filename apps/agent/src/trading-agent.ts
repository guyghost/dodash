import { executePaperOrder } from "@dodash/backtest";
import { err, ok, type OrderIntent } from "@dodash/domain";
import {
  type ControlPermissions,
  type TradingCycleEvent,
  type WorkflowError,
} from "@dodash/models";
import { Agent } from "agents";

import {
  parseAgentConfiguration,
  type AgentConfiguration,
} from "./configuration.js";
import { runTradingCycle } from "./interpreter.js";
import { createTradingMachineSession, type PersistedTradingMachine } from "./machine-session.js";
import { fetchMarketSnapshot } from "./market-service.js";
import {
  INITIAL_AGENT_STATE,
  machineIsEnabled,
  resolveCycleInvocation,
  type CycleSummary,
  type TradingAgentState,
} from "./state.js";
import type {
  CycleArtifacts,
  OrderSubmission,
  TradingCycleEffects,
} from "./types.js";

export interface TradingEnv extends Env {
  readonly INTERNAL_SERVICE_TOKEN: string;
  readonly CONTROL_API_TOKEN: string;
}

export type AgentCommandResult =
  | { readonly ok: true; readonly state: TradingAgentState }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "INVALID_CONFIGURATION"
          | "INVALID_STATE"
          | "NOT_CONFIGURED";
      };
    };

const storageError = (retryable = true): WorkflowError => ({
  phase: "persistence",
  code: "PERSISTENCE_FAILURE",
  retryable,
});

const executionError = (
  code: "ORDER_REJECTED" | "ORDER_OUTCOME_UNKNOWN",
  retryable: boolean,
): WorkflowError => ({ phase: "execution", code, retryable });

const parseJson = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export class TradingAgent extends Agent<TradingEnv, TradingAgentState> {
  override initialState = INITIAL_AGENT_STATE;

  override async onStart(): Promise<void> {
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

    if (this.state.enabled && this.state.configuration !== null) {
      await this.ensureIntervalSchedule(this.state.configuration.intervalSeconds);
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
    const configuration = parseAgentConfiguration(configurationInput);
    if (!configuration.ok) {
      return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
    }

    const currentPhase = this.state.machine?.value ?? "stopped";
    if (currentPhase !== "stopped") {
      return { ok: false, error: { code: "INVALID_STATE" } };
    }

    if (
      this.state.schedule !== null &&
      this.state.schedule.intervalSeconds !== configuration.value.intervalSeconds
    ) {
      await this.cancelSchedule(this.state.schedule.id);
    }

    const session = createTradingMachineSession({
      agentId: this.name,
      strategyIds: configuration.value.strategyIds,
    });
    session.send({ type: "START_REQUESTED", permissions });
    const machine = session.record;
    session.stop();

    this.setState({
      ...INITIAL_AGENT_STATE,
      configuration: configuration.value,
      machine,
      enabled: machineIsEnabled(machine.value),
      schedule:
        this.state.schedule?.intervalSeconds === configuration.value.intervalSeconds
          ? this.state.schedule
          : null,
      portfolio: {
        cash: configuration.value.initialCapital,
        positionQuantity: 0,
        averagePrice: 0,
      },
      updatedAt: Date.now(),
    });

    await this.runCurrent(false);
    return { ok: true, state: this.state };
  }

  async stopAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    return this.control({ type: "STOP_REQUESTED", permissions });
  }

  async killAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    return this.control({ type: "KILL_SWITCH_ENGAGED", permissions });
  }

  async resetAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    if (this.state.machine === null || this.state.configuration === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    const session = createTradingMachineSession(
      {
        agentId: this.name,
        strategyIds: this.state.configuration.strategyIds,
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
    if (this.state.configuration === null || this.state.machine === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    await this.runCurrent(true);
    return { ok: true, state: this.state };
  }

  async scheduledTick(): Promise<void> {
    if (!this.state.enabled) return;
    await this.runCurrent(true);
  }

  getAgentState(): TradingAgentState {
    return this.state;
  }

  listRecentCycles(limit = 50): readonly Record<string, unknown>[] {
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
    if (this.state.machine === null || this.state.configuration === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    const session = createTradingMachineSession(
      {
        agentId: this.name,
        strategyIds: this.state.configuration.strategyIds,
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
    return { ok: true, state: this.state };
  }

  private async runCurrent(
    triggerAlarm: boolean,
    resumeCycleIdOverride?: string | null,
  ): Promise<void> {
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
    const result = await runTradingCycle({
      agentId: this.name,
      configuration,
      machine,
      artifacts,
      previousIndicators: this.state.previousIndicators,
      portfolio: this.state.portfolio,
      dailyPnl: this.state.dailyPnl,
      lastTradeAt: this.state.lastTradeAt,
      triggeredAt: identity.triggeredAt,
      cycleId: identity.cycleId,
      triggerAlarm,
      effects: this.createEffects(configuration),
    });

    const lastPrice = result.artifacts?.market?.candles.at(-1)?.close ?? null;
    const equity =
      lastPrice === null
        ? configuration.initialCapital + this.state.dailyPnl
        : result.portfolio.cash + result.portfolio.positionQuantity * lastPrice;
    const executed = result.artifacts?.execution !== undefined;
    const lastCycle = this.toCycleSummary(result.artifacts, result.machine);
    this.setState({
      ...this.state,
      machine: result.machine,
      enabled: machineIsEnabled(result.machine.value),
      portfolio: result.portfolio,
      dailyPnl: equity - configuration.initialCapital,
      lastTradeAt: executed
        ? result.artifacts?.triggeredAt ?? this.state.lastTradeAt
        : this.state.lastTradeAt,
      previousIndicators: result.previousIndicators,
      lastCycle: lastCycle ?? this.state.lastCycle,
      updatedAt: Date.now(),
    });

    if (!machineIsEnabled(result.machine.value)) {
      await this.removeIntervalSchedule();
    }
  }

  private createEffects(configuration: AgentConfiguration): TradingCycleEffects {
    return {
      fetchMarketData: async (config, triggeredAt) =>
        fetchMarketSnapshot(
          this.env.MARKET_DATA,
          this.env.INTERNAL_SERVICE_TOKEN,
          config,
          triggeredAt,
        ),
      ensureSchedule: async (intervalSeconds) => {
        try {
          const schedule = await this.ensureIntervalSchedule(intervalSeconds);
          return ok({ nextWakeAt: schedule.time });
        } catch {
          return err({
            phase: "schedule",
            code: "SCHEDULE_FAILURE",
            retryable: true,
          });
        }
      },
      checkpoint: async (artifacts) => this.checkpoint(artifacts),
      persistMachine: async (nextMachine) => this.persistMachine(nextMachine),
      persistOrderIntent: async (cycleId, intent) =>
        this.persistOrderIntent(cycleId, intent),
      authorize: async () => {
        const issuedAt = Date.now();
        return ok({ issuedAt, expiresAt: issuedAt + 60_000 });
      },
      submitOrder: async (intent, _authorization, marketPrice, portfolio, at) =>
        this.submitPaperOrder(intent, marketPrice, portfolio, at, configuration),
      reconcileOrder: async (intent) => this.reconcilePaperOrder(intent),
      cancelCurrentEffect: async () => {
        try {
          await this.removeIntervalSchedule();
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
        this.persistCycle(cycleArtifacts, nextMachine),
    };
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
