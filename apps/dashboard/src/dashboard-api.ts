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
  readonly equity: number;
}

export interface PnlCycleView {
  readonly cycleId: string;
  readonly triggeredAt: number;
  readonly completedAt: number | null;
  readonly outcome: string;
  readonly marketPrice: number | null;
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
    !isFiniteNumber(value.portfolio.cash) ||
    !isFiniteNumber(value.portfolio.positionQuantity) ||
    !isFiniteNumber(value.portfolio.averagePrice) ||
    !isFiniteNumber(value.dailyPnl)
  ) {
    throw invalidResponse();
  }
  const machineContext = value.machine.context;
  if (!isRecord(machineContext)) throw invalidResponse();

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

const optionalFinite = (value: unknown): number | null => {
  if (value === null) return null;
  if (!isFiniteNumber(value)) throw invalidResponse();
  return value;
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
    if (!isRecord(point) || !isSafeTime(point.t) || !isFiniteNumber(point.equity)) {
      throw invalidResponse();
    }
    return Object.freeze({ t: point.t, equity: point.equity });
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
    return Object.freeze({
      cycleId: cycle.cycleId,
      triggeredAt: cycle.triggeredAt,
      completedAt: cycle.completedAt,
      outcome: cycle.outcome,
      marketPrice: optionalPositiveFinite(cycle.marketPrice),
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
