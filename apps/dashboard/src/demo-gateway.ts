import type {
  AgentStateView,
  CycleView,
  DashboardGateway,
  StartConfiguration,
} from "./dashboard-api.js";

const wait = async (): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, 260));

const startedAt = Date.now();
let state: AgentStateView = Object.freeze({
  enabled: true,
  phase: "waiting",
  updatedAt: startedAt,
  configuration: Object.freeze({
    productId: "BTC-USD",
    timeframe: "FIVE_MINUTE",
    strategyIds: Object.freeze(["breakout", "ema-cross", "rsi-reversion"]),
    intervalSeconds: 300,
    executionMode: "paper",
  }),
  portfolio: Object.freeze({
    cash: 8_642.14,
    positionQuantity: 0.0184,
    averagePrice: 61_284.42,
  }),
  dailyPnl: 172.38,
  nextWakeAt: startedAt + 184_000,
  lastTradeAt: startedAt - 886_000,
  lastCycle: Object.freeze({
    cycleId: "cycle-01J6A2J8X7",
    outcome: "ORDER_CONFIRMED",
    marketPrice: 63_912.18,
    signalCount: 3,
    completedAt: startedAt - 886_000,
  }),
  indicators: Object.freeze({
    rsi: 61.8,
    emaFast: 63_782.24,
    emaSlow: 63_401.16,
    macd: 381.08,
    atr: 842.4,
  }),
});

let cycles: readonly CycleView[] = Object.freeze([
  {
    cycleId: "cycle-01J6A2J8X7",
    triggeredAt: startedAt - 890_000,
    completedAt: startedAt - 886_000,
    phase: "scheduling",
    outcome: "ORDER_CONFIRMED",
  },
  {
    cycleId: "cycle-01J6A1TB4M",
    triggeredAt: startedAt - 1_190_000,
    completedAt: startedAt - 1_187_000,
    phase: "scheduling",
    outcome: "NO_ACTION",
  },
  {
    cycleId: "cycle-01J6A14QPC",
    triggeredAt: startedAt - 1_490_000,
    completedAt: startedAt - 1_486_000,
    phase: "scheduling",
    outcome: "RISK_REJECTED",
  },
]);

const nextState = (patch: Partial<AgentStateView>): AgentStateView =>
  Object.freeze({ ...state, ...patch, updatedAt: Date.now() });

export const createDemoGateway = (): DashboardGateway =>
  Object.freeze({
    loadState: async (_agentName: string) => {
      await wait();
      return state;
    },
    loadCycles: async (_agentName: string) => {
      await wait();
      return cycles;
    },
    submitPerpOrder: async (
      _agentName: string,
      body: Parameters<DashboardGateway["submitPerpOrder"]>[1],
    ) => {
      await wait();
      return {
        status: "SETTLED" as const,
        outcome: "ACCEPTED" as const,
        clientOrderId: body.clientOrderId,
      };
    },
    command: async (
      _agentName: string,
      command: Parameters<DashboardGateway["command"]>[1],
      configuration?: StartConfiguration,
    ) => {
      await wait();
      if (command === "start") {
        state = nextState({
          enabled: true,
          phase: "waiting",
          configuration: Object.freeze({
            productId: configuration?.productId ?? "BTC-USD",
            timeframe: configuration?.timeframe ?? "FIVE_MINUTE",
            strategyIds: Object.freeze(
              configuration?.strategyIds ?? ["rsi-reversion"],
            ),
            intervalSeconds: configuration?.timeframe === "ONE_MINUTE" ? 60 : 300,
            executionMode: configuration?.executionMode ?? "paper",
          }),
          nextWakeAt: Date.now() + 300_000,
        });
      } else if (command === "stop" || command === "reset") {
        state = nextState({ enabled: false, phase: "stopped", nextWakeAt: null });
      } else if (command === "kill") {
        state = nextState({ enabled: false, phase: "halted", nextWakeAt: null });
      } else {
        const cycle: CycleView = Object.freeze({
          cycleId: `cycle-demo-${cycles.length + 1}`,
          triggeredAt: Date.now() - 1_200,
          completedAt: Date.now(),
          phase: "scheduling",
          outcome: "NO_ACTION",
        });
        cycles = Object.freeze([cycle, ...cycles].slice(0, 12));
        state = nextState({
          enabled: true,
          phase: "waiting",
          nextWakeAt: Date.now() + 300_000,
          lastCycle: Object.freeze({
            cycleId: cycle.cycleId,
            outcome: cycle.outcome,
            marketPrice: 63_948.72,
            signalCount: 3,
            completedAt: cycle.completedAt ?? Date.now(),
          }),
        });
      }
      return state;
    },
  });
