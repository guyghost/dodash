import { err, ok, type OrderIntent, type ProductId, type Result } from "@dodash/domain";
import { executePaperOrder } from "@dodash/paper-execution";
import type { RiskDecision } from "@dodash/risk";
import {
  assessLiveTradingAgentIdentity,
  DASHBOARD_PNL_HISTORY_DEFAULT_LIMIT,
  DASHBOARD_PNL_HISTORY_MAX_CYCLES,
  projectDashboardPnlHistory,
  type ControlPermissions,
  type DashboardPnlHistoryResult,
  type DashboardPnlOrderRow,
  type TradingCycleEvent,
  type LivePreflightFailureReason,
  type WorkflowError,
} from "@dodash/models";
import { Agent } from "agents";

import {
  admitAgentConfiguration,
  isMultiProductConfigurationInput,
  parseAgentConfiguration,
  parseMultiProductAgentConfiguration,
  projectProductSlotConfiguration,
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
  PERP_FILLS_SCHEMA,
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
import {
  createPortfolioMachineSession,
  initialProductRuntime,
  portfolioEventForProductPhase,
  portfolioProductIds,
  productGrossExposure,
  proposePortfolioRisk,
  resolveRestoredPortfolioSession,
  sendPortfolioEvent,
  type PersistedPortfolioMachine,
  type PortfolioSessionState,
} from "./portfolio-runtime.js";
import { createTradingMachineSession, type PersistedTradingMachine } from "./machine-session.js";
import {
  INITIAL_AGENT_STATE,
  machineIsEnabled,
  portfolioIsEnabled,
  resolveCycleDailyRiskCompletion,
  resolveCycleDailyRiskStart,
  resolveCycleInvocation,
  resolveLiveStartContinuity,
  type CycleSummary,
  type PortfolioProductRuntime,
  type TradingAgentState,
} from "./state.js";
import {
  emitTradingTelemetry,
  type TradingTelemetryEvent,
  type TradingTelemetrySink,
} from "./telemetry.js";
import {
  createOperatorNotificationDeduper,
  emitOperatorNotifications,
  resolveOperatorNotificationSettings,
  type OperatorNotificationSourceKind,
} from "./operator-notifications.js";
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
  readonly OPERATOR_NOTIFY_WEBHOOK_URL?: string;
  readonly OPERATOR_NOTIFY_SECRET?: string;
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
          | "HYPERLIQUID_EXECUTION_UNAVAILABLE"
          | "MULTI_PRODUCT_LIVE_UNSUPPORTED"
          | "MULTI_PRODUCT_UNSUPPORTED";
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

  private readonly operatorNotificationDeduper =
    createOperatorNotificationDeduper();

  /**
   * Effet de bord de sortie (dao #23) : ajoute la notification opérateur à
   * l'émission télémétrie. Fire-and-forget : ne peut pas changer une
   * transition ni bloquer le cycle.
   */
  private emitOperatorSideEffects(
    kind: OperatorNotificationSourceKind,
    event: TradingTelemetryEvent,
  ): void {
    const settings = resolveOperatorNotificationSettings(this.env);
    emitOperatorNotifications(
      settings.ok ? settings.value : undefined,
      kind,
      event,
      this.operatorNotificationDeduper,
    );
  }

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
        product_id TEXT,
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
        product_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    // §9.7 : tables existantes étendues du productId — migration
    // idempotente pour les instances créées avant le branchement.
    this.ensureProductIdColumn("dodash_cycles");
    this.ensureProductIdColumn("dodash_orders");
    this.sql`
      CREATE TABLE IF NOT EXISTS dodash_sell_workflows (
        client_order_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.ctx.storage.sql.exec(PERP_ORDERS_SCHEMA);
    // dao #31 : fills perp — migration additive (CREATE TABLE IF NOT
    // EXISTS), idempotente, aucune ligne existante modifiée (C1).
    this.ctx.storage.sql.exec(PERP_FILLS_SCHEMA);
  }

  private ensureProductIdColumn(table: string): void {
    const columns = this.ctx.storage.sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray() as unknown as readonly { name: string }[];
    if (!columns.some((column) => column.name === "product_id")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE ${table} ADD COLUMN product_id TEXT`,
      );
    }
  }

  /**
   * Restauration fail-closed de la session portefeuille (C3, règle
   * models/agent-runtime.md) : tout champ ajouté est normalisé ; un
   * instantané invalide est un refus fermé explicite — jamais un
   * démarrage dégradé silencieux.
   */
  private restorePortfolioSession(): void {
    const persisted =
      (this.state as { portfolioSession?: unknown }).portfolioSession ?? null;
    if (persisted === null) {
      // Instantané legacy : normalisation unique des champs ajoutés
      // (règle models/agent-runtime.md) — aucune écriture si déjà fait.
      if (
        this.state.portfolioSession !== null ||
        this.state.portfolioRestoreError !== null
      ) {
        this.setState({
          ...this.state,
          portfolioSession: null,
          portfolioRestoreError: null,
        });
      }
      return;
    }
    const restored = resolveRestoredPortfolioSession(persisted);
    if (restored.ok) {
      this.setState({
        ...this.state,
        portfolioSession: restored.session,
        portfolioRestoreError: null,
      });
      return;
    }
    console.error(
      JSON.stringify({
        type: "PORTFOLIO_RESTORE_FAILED",
        reason: restored.reason,
      }),
    );
    this.setState({
      ...this.state,
      portfolioSession: null,
      portfolioRestoreError: restored.reason,
      enabled: false,
      updatedAt: Date.now(),
    });
  }

  override async onStart(): Promise<void> {
    this.ensureTradingPersistenceSchema();
    this.restorePortfolioSession();
    const portfolio = this.state.portfolioSession;
    if (this.state.enabled && portfolio !== null) {
      await this.ensureIntervalSchedule(portfolio.configuration.intervalSeconds);
      return;
    }
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
    // Branchement runtime multi-produits (models/multi-product-portfolio.md
    // §9) : N ≥ 2 créneaux pilotent le portefeuille ; N = 1 suit la voie
    // legacy normalisée, sémantique strictement identique (C2).
    if (isMultiProductConfigurationInput(configurationInput)) {
      return this.startPortfolioAgent(configurationInput, permissions);
    }
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
    if (this.state.portfolioSession !== null) {
      return this.stopPortfolioAgent(permissions);
    }
    return this.control({ type: "STOP_REQUESTED", permissions });
  }

  async killAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    if (this.state.portfolioSession !== null) {
      return this.killPortfolioAgent(permissions);
    }
    return this.control({
      type: "KILL_SWITCH_ENGAGED",
      permissions,
      controlId: crypto.randomUUID(),
    });
  }

  async resetAgent(permissions: ControlPermissions): Promise<AgentCommandResult> {
    this.ensureTradingPersistenceSchema();
    if (this.state.portfolioSession !== null) {
      return this.resetPortfolioAgent(permissions);
    }
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
    if (this.state.portfolioSession !== null) {
      await this.runPortfolio(true);
      return { ok: true, state: this.state };
    }
    if (this.state.configuration === null || this.state.machine === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    await this.runCurrent(true);
    return { ok: true, state: this.state };
  }

  async scheduledTick(): Promise<void> {
    this.ensureTradingPersistenceSchema();
    if (this.state.portfolioSession !== null) {
      await this.runPortfolio(true);
      return;
    }
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

  /**
   * Projection PnL/équité lecture-seule (dao #26) : deux lectures SQL
   * locales bornées, aucun appel réseau sortant, aucun calcul UI.
   * Source normative : models/dashboard-pnl-history.md §3-§4.
   */
  getPnlHistory(
    limit: number = DASHBOARD_PNL_HISTORY_DEFAULT_LIMIT,
  ): DashboardPnlHistoryResult {
    this.ensureTradingPersistenceSchema();
    const boundedLimit = Math.max(
      1,
      Math.min(DASHBOARD_PNL_HISTORY_MAX_CYCLES, Math.trunc(limit)),
    );
    const cycles = this.sql<{
      cycle_id: string;
      triggered_at: number;
      completed_at: number | null;
      outcome: string;
      artifacts_json: string;
    }>`
      SELECT cycle_id, triggered_at, completed_at, outcome, artifacts_json
      FROM dodash_cycles
      ORDER BY triggered_at DESC
      LIMIT ${boundedLimit}
    `;
    const cycleIds = cycles.map((row) => row.cycle_id);
    const orders = (
      cycleIds.length === 0
        ? []
        : (
            this.ctx.storage.sql.exec(
              `SELECT client_order_id, cycle_id, status, execution_json
               FROM dodash_orders
               WHERE cycle_id IN (${cycleIds.map(() => "?").join(", ")})
               ORDER BY client_order_id ASC`,
              ...cycleIds,
            ).toArray() as readonly Record<string, string | number | null>[]
          ).map((row): DashboardPnlOrderRow => ({
            clientOrderId: row.client_order_id as string,
            cycleId: row.cycle_id as string,
            status: row.status as string,
            executionJson:
              row.execution_json === null ? null : (row.execution_json as string),
          }))
    );
    return projectDashboardPnlHistory(
      cycles.map((row) => ({
        cycleId: row.cycle_id,
        triggeredAt: row.triggered_at,
        completedAt: row.completed_at,
        outcome: row.outcome,
        artifactsJson: row.artifacts_json,
      })),
      orders,
      boundedLimit,
    );
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
    const controlEvent: TradingTelemetryEvent = {
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
    };
    emitTradingTelemetry(this.env.TRADING_TELEMETRY, controlEvent);
    this.emitOperatorSideEffects("control", controlEvent);
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
      const cycleEvent: TradingTelemetryEvent = {
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
      };
      emitTradingTelemetry(this.env.TRADING_TELEMETRY, cycleEvent);
      this.emitOperatorSideEffects("cycle", cycleEvent);
    }

    if (!machineIsEnabled(result.machine.value)) {
      await this.removeIntervalSchedule();
    }
  }

  /**
   * Démarrage du portefeuille (models/multi-product-portfolio.md §9.1,
   * §9.6) : configuration figée modifiable uniquement à l'état quiescent ;
   * chaque créneau est admis individuellement par les admissions
   * existantes — un seul refus ⇒ démarrage refusé (C4/INV-P7 : le
   * multi-produits hors paper reste rejeté fail-closed) ; l'orchestrateur
   * du §5 doit être `running` après PORTFOLIO_STARTED, sinon refus (C3).
   */
  private async startPortfolioAgent(
    configurationInput: unknown,
    permissions: ControlPermissions,
  ): Promise<AgentCommandResult> {
    const parsed = parseMultiProductAgentConfiguration(configurationInput);
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          code:
            parsed.error.code === "MULTI_PRODUCT_LIVE_UNSUPPORTED"
              ? "MULTI_PRODUCT_LIVE_UNSUPPORTED"
              : "INVALID_CONFIGURATION",
        },
      };
    }
    const multi = parsed.value;
    // C4/INV-P7 : défense en profondeur — la configuration est déjà
    // paper-only au parse ; la porte runtime ne lève jamais la porte.
    if (multi.executionMode !== "paper") {
      return { ok: false, error: { code: "MULTI_PRODUCT_LIVE_UNSUPPORTED" } };
    }
    if (multi.portfolioRisk === undefined) {
      return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
    }
    if (
      (this.state.portfolioSession !== null &&
        portfolioIsEnabled(this.state.portfolioSession)) ||
      (this.state.machine !== null && machineIsEnabled(this.state.machine.value))
    ) {
      return { ok: false, error: { code: "INVALID_STATE" } };
    }
    // §9.6 : admission individuelle de chaque créneau par les admissions
    // existantes (politiques figées) ; une seule admission refusée ⇒
    // démarrage refusé.
    for (const slot of multi.products) {
      const projected = projectProductSlotConfiguration(multi, slot.productId);
      if (!projected.ok) {
        return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
      }
      const admission = admitAgentConfiguration(projected.value);
      if (admission.status === "REJECTED") {
        return { ok: false, error: { code: admission.reasonCode } };
      }
    }
    if (this.state.schedule !== null) {
      await this.cancelSchedule(this.state.schedule.id);
    }

    const portfolioSession = createPortfolioMachineSession({
      products: multi.products.map((slot) => slot.productId),
      limits: multi.portfolioRisk,
    });
    portfolioSession.send({ type: "PORTFOLIO_STARTED" });
    const portfolioRecord = portfolioSession.record;
    portfolioSession.stop();
    // Fail-closed (C3) : un orchestrateur non `running` n'amorce jamais.
    if (portfolioRecord.value !== "running") {
      return { ok: false, error: { code: "INVALID_CONFIGURATION" } };
    }

    const products: Record<string, PortfolioProductRuntime> = {};
    for (const slot of multi.products) {
      const productSession = createTradingMachineSession({
        agentId: this.name,
        strategyIds: multi.strategyIds,
        maxMarketStalenessMs: multi.maxMarketStalenessMs,
      });
      productSession.send({ type: "START_REQUESTED", permissions });
      const machine = productSession.record;
      productSession.stop();
      products[slot.productId] = initialProductRuntime(
        machine,
        multi.initialCapital,
      );
    }

    this.setState({
      ...INITIAL_AGENT_STATE,
      enabled: true,
      portfolioSession: Object.freeze({
        configuration: multi,
        portfolio: portfolioRecord,
        products: Object.freeze(products),
      }),
      portfolioRestoreError: null,
      updatedAt: Date.now(),
    });

    await this.runPortfolio(false);
    return { ok: true, state: this.state };
  }

  private async stopPortfolioAgent(
    permissions: ControlPermissions,
  ): Promise<AgentCommandResult> {
    const session = this.state.portfolioSession;
    if (session === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    for (const productId of portfolioProductIds(session)) {
      const product = session.products[productId];
      if (product === undefined || !machineIsEnabled(product.machine.value)) {
        continue;
      }
      await this.controlProduct(session, productId, {
        type: "STOP_REQUESTED",
        permissions,
      });
    }
    await this.runPortfolio(false);
    return { ok: true, state: this.state };
  }

  /**
   * Kill portefeuille (§5, §9.5) : l'orchestrateur passe en `draining`
   * (plus aucune admission consolidée), chaque produit actif draine son
   * propre cycle ; le portefeuille atteint `halted` à la quiescence.
   */
  private async killPortfolioAgent(
    permissions: ControlPermissions,
  ): Promise<AgentCommandResult> {
    const session = this.state.portfolioSession;
    if (session === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    this.persistPortfolio(
      sendPortfolioEvent(session.portfolio, {
        type: "KILL_SWITCH_ENGAGED",
        controlId: crypto.randomUUID(),
      }),
    );
    for (const productId of portfolioProductIds(session)) {
      const product = session.products[productId];
      if (product === undefined || !machineIsEnabled(product.machine.value)) {
        continue;
      }
      await this.controlProduct(session, productId, {
        type: "KILL_SWITCH_ENGAGED",
        permissions,
        controlId: crypto.randomUUID(),
      });
    }
    await this.runPortfolio(false);
    return { ok: true, state: this.state };
  }

  private async resetPortfolioAgent(
    permissions: ControlPermissions,
  ): Promise<AgentCommandResult> {
    const session = this.state.portfolioSession;
    if (session === null) {
      return { ok: false, error: { code: "NOT_CONFIGURED" } };
    }
    for (const productId of portfolioProductIds(session)) {
      await this.controlProduct(session, productId, {
        type: "RESET",
        permissions,
      });
    }
    const latest = this.state.portfolioSession;
    if (latest !== null) {
      this.persistPortfolio(sendPortfolioEvent(latest.portfolio, { type: "RESET" }));
    }
    return { ok: true, state: this.state };
  }

  /** Événement de contrôle typé vers la machine d'un seul produit. */
  private async controlProduct(
    session: PortfolioSessionState,
    productId: ProductId,
    event: TradingCycleEvent,
  ): Promise<void> {
    const product = session.products[productId];
    if (product === undefined) return;
    const machine = createTradingMachineSession(
      {
        agentId: this.name,
        strategyIds: session.configuration.strategyIds,
        maxMarketStalenessMs: session.configuration.maxMarketStalenessMs,
      },
      product.machine,
    );
    machine.send(event);
    const record = machine.record;
    machine.stop();
    this.persistProductMachine(productId, record);
  }

  private persistPortfolio(portfolio: PersistedPortfolioMachine): void {
    const session = this.state.portfolioSession;
    if (session === null) return;
    this.setState({
      ...this.state,
      portfolioSession: { ...session, portfolio },
      updatedAt: Date.now(),
    });
  }

  private persistProductMachine(
    productId: ProductId,
    machine: PersistedTradingMachine,
  ): void {
    const session = this.state.portfolioSession;
    if (session === null) return;
    const product = session.products[productId];
    if (product === undefined) return;
    const products = { ...session.products, [productId]: { ...product, machine } };
    const next = { ...session, products: Object.freeze(products) };
    this.setState({
      ...this.state,
      portfolioSession: next,
      enabled: portfolioIsEnabled(next),
      updatedAt: Date.now(),
    });
  }

  /**
   * §9.4 : publication de l'exposition et du PnL quotidien d'un produit
   * à l'orchestrateur du §5 depuis le dernier état persisté (au réveil
   * et après chaque cycle produit).
   */
  private reportProductExposureFromState(productId: ProductId): void {
    const session = this.state.portfolioSession;
    if (session === null) return;
    const product = session.products[productId];
    if (product === undefined) return;
    this.persistPortfolio(
      sendPortfolioEvent(session.portfolio, {
        type: "PRODUCT_EXPOSURE_REPORTED",
        productId,
        grossExposure: productGrossExposure(
          product.portfolio,
          product.lastCycle?.marketPrice ?? null,
        ),
        dailyPnl: product.dailyPnl,
      }),
    );
  }

  /**
   * Ordonnancement déterministe (INV-P4) : les créneaux sont parcourus
   * dans l'ordre trié figé de la configuration ; l'arrêt ou l'échec d'un
   * produit ne re-planifie jamais les autres (INV-P3). L'alarme partagée
   * n'est retirée qu'à la quiescence du portefeuille entier.
   */
  private async runPortfolio(triggerAlarm: boolean): Promise<void> {
    const session = this.state.portfolioSession;
    if (session === null) return;
    if (triggerAlarm) {
      for (const productId of portfolioProductIds(session)) {
        this.reportProductExposureFromState(productId);
      }
    }
    for (const productId of portfolioProductIds(session)) {
      const current = this.state.portfolioSession;
      if (current === null) return;
      const product = current.products[productId];
      if (
        product === undefined ||
        !machineIsEnabled(product.machine.value)
      ) {
        continue;
      }
      await this.runProductCycle(current, productId, triggerAlarm);
    }
    const current = this.state.portfolioSession;
    if (current !== null && !portfolioIsEnabled(current)) {
      await this.removeIntervalSchedule();
    }
  }

  /** Cycle d'un seul produit : projection §9.2 de models/agent-runtime.md. */
  private async runProductCycle(
    session: PortfolioSessionState,
    productId: ProductId,
    triggerAlarm: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    const product = session.products[productId];
    if (product === undefined) return;
    const projected = projectProductSlotConfiguration(session.configuration, productId);
    if (!projected.ok) {
      // Créneau restauré incohérent : refus fermé du produit (C3) sans
      // re-planifier les autres (INV-P3).
      const latest = this.state.portfolioSession;
      if (latest !== null) {
        this.persistPortfolio(
          sendPortfolioEvent(latest.portfolio, {
            type: "PRODUCT_FAILED",
            productId,
          }),
        );
      }
      return;
    }
    const configuration = projected.value;
    const identity = resolveCycleInvocation(
      product.machine,
      triggerAlarm,
      Date.now(),
      crypto.randomUUID(),
    );
    const artifacts =
      identity.loadCycleId === null
        ? null
        : this.loadArtifacts(identity.loadCycleId, productId);
    const knownPrice = product.lastCycle?.marketPrice ?? null;
    const startingEquity =
      product.portfolio.cash +
      product.portfolio.positionQuantity *
        (knownPrice ?? product.portfolio.averagePrice);
    const dailyRiskAtStart = resolveCycleDailyRiskStart(
      configuration.executionMode,
      product.dailyRiskWindow ?? null,
      product.dailyPnl,
      identity.triggeredAt,
      startingEquity,
    );
    const result = await runTradingCycle({
      agentId: this.name,
      configuration,
      machine: product.machine,
      artifacts,
      previousIndicators: product.previousIndicators,
      portfolio: product.portfolio,
      dailyPnl: dailyRiskAtStart.dailyPnl,
      dailyRiskWindow: dailyRiskAtStart.window,
      lastTradeAt: product.lastTradeAt,
      triggeredAt: identity.triggeredAt,
      cycleId: identity.cycleId,
      triggerAlarm,
      effects: this.createProductEffects(configuration),
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
    const updated: PortfolioProductRuntime = Object.freeze({
      machine: result.machine,
      portfolio: result.portfolio,
      dailyRiskWindow: dailyRisk.window,
      dailyPnl: dailyRisk.dailyPnl,
      lastTradeAt: executed
        ? result.artifacts?.triggeredAt ?? product.lastTradeAt
        : product.lastTradeAt,
      previousIndicators: result.previousIndicators,
      lastCycle: lastCycle ?? product.lastCycle,
    });
    const currentSession = this.state.portfolioSession;
    if (currentSession !== null) {
      const products = { ...currentSession.products, [productId]: updated };
      const next = { ...currentSession, products: Object.freeze(products) };
      this.setState({
        ...this.state,
        portfolioSession: next,
        enabled: portfolioIsEnabled(next),
        updatedAt: Date.now(),
      });
    }

    // §9.4 : rapport d'exposition après le cycle produit.
    this.reportProductExposureFromState(productId);
    // §9.5 : l'état terminal du produit est publié à l'orchestrateur —
    // les autres produits ne sont jamais re-planifiés (INV-P3).
    const terminalEvent = portfolioEventForProductPhase(productId, result.machine.value);
    if (terminalEvent !== null) {
      const latest = this.state.portfolioSession;
      if (latest !== null) {
        this.persistPortfolio(sendPortfolioEvent(latest.portfolio, terminalEvent));
      }
    }

    if (result.artifacts !== null) {
      const cycleEvent: TradingTelemetryEvent = {
        schemaVersion: 1,
        type: "cycle.completed",
        timestamp: Date.now(),
        agentId: this.name,
        productId,
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
      };
      emitTradingTelemetry(this.env.TRADING_TELEMETRY, cycleEvent);
      this.emitOperatorSideEffects("cycle", cycleEvent);
    }
  }

  /**
   * Effets d'un créneau (§9.2) : projection à l'identique de
   * models/agent-runtime.md, avec le productId sur la persistance ; la
   * couture d'admission consolidée (§9.3) est câblée sur l'orchestrateur
   * du §5 — la garde décide, l'effet transporte (INV-P5).
   */
  private createProductEffects(
    configuration: AgentConfiguration,
  ): TradingCycleEffects {
    const productId = configuration.productId;
    const base = createTradingCycleEffects({
      configuration,
      env: this.env,
      agentName: this.name,
      ensureIntervalSchedule: (intervalSeconds) =>
        this.ensureIntervalSchedule(intervalSeconds),
      // INV-P3 : l'alarme partagée appartient au portefeuille — un
      // produit en cancellation ne la retire jamais (paper : rien à
      // liquider, le drain est porté par le portefeuille).
      removeIntervalSchedule: () => Promise.resolve(),
      checkpoint: (artifacts) => this.checkpoint(artifacts, productId),
      persistMachine: async (nextMachine) =>
        this.persistProductMachine(productId, nextMachine),
      persistOrderIntent: (cycleId, intent) =>
        this.persistOrderIntent(cycleId, intent, productId),
      submitPaperOrder: (intent, marketPrice, portfolio, executedAt, config) =>
        this.submitPaperOrder(intent, marketPrice, portfolio, executedAt, config, productId),
      submitLiveOrder: (settings, intent, riskDecision, authorization) =>
        this.submitLiveOrder(settings, intent, riskDecision, authorization),
      submitPerpOrder: (settings, intent, riskDecision, marketPrice) =>
        this.submitPerpSignalOrder(settings, intent, riskDecision, marketPrice),
      reconcilePaperOrder: (intent) => this.reconcilePaperOrder(intent, productId),
      reconcileLiveOrder: (settings, intent, riskDecision, portfolio) =>
        this.reconcileLiveOrder(settings, intent, riskDecision, portfolio),
      reconcilePerpOrder: (settings, intent) =>
        this.reconcilePerpSignalOrder(settings, intent),
      persistCycle: (cycleArtifacts, nextMachine) =>
        this.persistCycle(cycleArtifacts, nextMachine, productId),
      loadKnownProtectiveOrderIds: () => this.loadKnownProtectiveOrderIds(),
      getKillContext: () => null,
      applyKilledAccount: () => undefined,
    });
    return {
      ...base,
      cancelCurrentEffect: async () => ok(undefined),
      proposePortfolioRisk: async (proposedProductId, proposedGrossExposure) => {
        const current = this.state.portfolioSession;
        if (current === null) {
          return { approved: false, reasonCode: "UNKNOWN_PRODUCT" };
        }
        const proposal = proposePortfolioRisk(
          current.portfolio,
          proposedProductId,
          proposedGrossExposure,
        );
        this.persistPortfolio(proposal.record);
        return proposal.decision;
      },
    };
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
    productId?: ProductId,
  ): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<WorkflowError>>> {
    try {
      const now = Date.now();
      const phase =
        productId === undefined
          ? this.state.machine?.value ?? "unknown"
          : this.state.portfolioSession?.products[productId]?.machine.value ??
            "unknown";
      const outcome =
        productId === undefined
          ? this.state.machine?.context.outcome ?? "RUNNING"
          : this.state.portfolioSession?.products[productId]?.machine.context
              .outcome ?? "RUNNING";
      this.sql`
        INSERT INTO dodash_cycles (
          cycle_id, triggered_at, completed_at, phase, outcome,
          artifacts_json, error_json, product_id, updated_at
        ) VALUES (
          ${artifacts.cycleId}, ${artifacts.triggeredAt}, NULL,
          ${phase},
          ${outcome},
          ${JSON.stringify(artifacts)}, NULL, ${productId ?? null}, ${now}
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

  private loadArtifacts(cycleId: string, productId?: ProductId): CycleArtifacts | null {
    const row =
      productId === undefined
        ? this.sql<{ artifacts_json: string }>`
            SELECT artifacts_json FROM dodash_cycles WHERE cycle_id = ${cycleId} LIMIT 1
          `.at(0)
        : this.sql<{ artifacts_json: string }>`
            SELECT artifacts_json FROM dodash_cycles
            WHERE cycle_id = ${cycleId} AND product_id = ${productId}
            LIMIT 1
          `.at(0);
    return row === undefined ? null : parseJson<CycleArtifacts>(row.artifacts_json);
  }

  private async persistOrderIntent(
    cycleId: string,
    intent: OrderIntent,
    productId?: ProductId,
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
          exchange_order_id, execution_json, product_id, created_at, updated_at
        ) VALUES (
          ${intent.clientOrderId}, ${cycleId}, ${serialized}, 'INTENT_PERSISTED',
          NULL, NULL, ${productId ?? null}, ${now}, ${now}
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
    productId?: ProductId,
  ): Promise<OrderSubmission> {
    const reconciled = await this.reconcilePaperOrder(intent, productId);
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
      if (productId === undefined) {
        this.sql`
          UPDATE dodash_orders SET
            status = 'CONFIRMED',
            exchange_order_id = ${submission.exchangeOrderId},
            execution_json = ${JSON.stringify(submission)},
            updated_at = ${now}
          WHERE client_order_id = ${intent.clientOrderId}
        `;
      } else {
        this.sql`
          UPDATE dodash_orders SET
            status = 'CONFIRMED',
            exchange_order_id = ${submission.exchangeOrderId},
            execution_json = ${JSON.stringify(submission)},
            updated_at = ${now}
          WHERE client_order_id = ${intent.clientOrderId}
            AND product_id = ${productId}
        `;
      }
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
    productId?: ProductId,
  ): Promise<
    | ReturnType<typeof ok<OrderSubmission>>
    | ReturnType<typeof err<WorkflowError>>
  > {
    try {
      const row =
        productId === undefined
          ? this.sql<{ status: string; execution_json: string | null }>`
              SELECT status, execution_json FROM dodash_orders
              WHERE client_order_id = ${intent.clientOrderId}
              LIMIT 1
            `.at(0)
          : this.sql<{ status: string; execution_json: string | null }>`
              SELECT status, execution_json FROM dodash_orders
              WHERE client_order_id = ${intent.clientOrderId}
                AND product_id = ${productId}
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
    productId?: ProductId,
  ): Promise<ReturnType<typeof ok<void>> | ReturnType<typeof err<WorkflowError>>> {
    if (artifacts === null) return ok(undefined);
    try {
      const now = Date.now();
      this.sql`
        INSERT INTO dodash_cycles (
          cycle_id, triggered_at, completed_at, phase, outcome,
          artifacts_json, error_json, product_id, updated_at
        ) VALUES (
          ${artifacts.cycleId}, ${artifacts.triggeredAt}, ${now},
          ${machine.value}, ${machine.context.outcome},
          ${JSON.stringify(artifacts)}, ${
            machine.context.lastError === null
              ? null
              : JSON.stringify(machine.context.lastError)
          },
          ${productId ?? null}, ${now}
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
