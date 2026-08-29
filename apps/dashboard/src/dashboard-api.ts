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
