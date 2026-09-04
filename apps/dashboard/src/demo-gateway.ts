import type {
  AgentStateView,
  CycleView,
  DashboardGateway,
  PnlHistoryView,
  PortfolioSummaryView,
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
  portfolioSummary: Object.freeze({ kind: "single-product" as const }),
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

const pnlHistory: PnlHistoryView = Object.freeze({
  equityCurve: Object.freeze([
    { t: startedAt - 2_090_000, equity: 9_812.4 },
    { t: startedAt - 1_490_000, equity: 9_774.02 },
    { t: startedAt - 1_190_000, equity: 9_869.76 },
    { t: startedAt - 890_000, equity: 9_964.56 },
  ]),
  cycles: Object.freeze([
    Object.freeze({
      cycleId: "cycle-01J6A2J8X7",
      triggeredAt: startedAt - 890_000,
      completedAt: startedAt - 886_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 63_912.18,
      side: "BUY" as const,
      quantity: 0.0184,
      fillPrice: 63_924.51,
      fee: 1.18,
      realizedPnl: null,
      slippageBps: 1.93,
    }),
    Object.freeze({
      cycleId: "cycle-01J6A1TB4M",
      triggeredAt: startedAt - 1_190_000,
      completedAt: startedAt - 1_187_000,
      outcome: "NO_ACTION",
      marketPrice: 63_402.11,
      side: null,
      quantity: null,
      fillPrice: null,
      fee: null,
      realizedPnl: null,
      slippageBps: null,
    }),
    Object.freeze({
      cycleId: "cycle-01J6A14QPC",
      triggeredAt: startedAt - 1_490_000,
      completedAt: startedAt - 1_486_000,
      outcome: "RISK_REJECTED",
      marketPrice: 63_118.4,
      side: null,
      quantity: null,
      fillPrice: null,
      fee: null,
      realizedPnl: null,
      slippageBps: null,
    }),
  ]),
  openPosition: Object.freeze({ quantity: 0.0184, averagePrice: 61_284.42 }),
  protection: Object.freeze({
    stopLossPrice: 58_220.2,
    takeProfitPrice: 67_412.86,
    protectiveOrderConfirmed: true,
  }),
});

const portfolioSummary: PortfolioSummaryView = Object.freeze({
  kind: "portfolio",
  phase: "running",
  killSwitchActive: false,
  products: Object.freeze([
    Object.freeze({
      productId: "BTC-USD",
      phase: "waiting",
      status: "running" as const,
      cash: 5_204.11,
      positionQuantity: 0.0184,
      averagePrice: 61_284.42,
      marketPrice: 63_912.18,
      grossExposure: 1_175.98,
      maxGrossExposure: 12_000,
      dailyPnl: 96.4,
      lastCycle: Object.freeze({
        cycleId: "cycle-01J6A2J8X7",
        triggeredAt: startedAt - 890_000,
        completedAt: startedAt - 886_000,
        outcome: "ORDER_CONFIRMED",
        marketPrice: 63_912.18,
      }),
    }),
    Object.freeze({
      productId: "ETH-USD",
      phase: "scheduling",
      status: "running" as const,
      cash: 3_410.02,
      positionQuantity: 0.31,
      averagePrice: 3_084.5,
      marketPrice: 3_121.77,
      grossExposure: 967.75,
      maxGrossExposure: 12_000,
      dailyPnl: 51.36,
      lastCycle: Object.freeze({
        cycleId: "cycle-01J6A2GRQ2",
        triggeredAt: startedAt - 920_000,
        completedAt: startedAt - 916_000,
        outcome: "NO_ACTION",
        marketPrice: 3_121.77,
      }),
    }),
    // Produit quiescent (INV-P3) : visible avec ses derniers chiffres connus.
    Object.freeze({
      productId: "SOL-USD",
      phase: "halted",
      status: "halted" as const,
      cash: 1_028.01,
      positionQuantity: 2.4,
      averagePrice: 148.22,
      marketPrice: 146.9,
      grossExposure: 352.56,
      maxGrossExposure: 12_000,
      dailyPnl: -24.63,
      lastCycle: Object.freeze({
        cycleId: "cycle-01J69ZKQ9M",
        triggeredAt: startedAt - 1_860_000,
        completedAt: startedAt - 1_856_000,
        outcome: "FAILED",
        marketPrice: 146.9,
      }),
    }),
  ]),
  consolidated: Object.freeze({
    grossExposure: 2_496.29,
    maxGrossExposure: 30_000,
    dailyPnl: 123.13,
    maxDailyLoss: 1_500,
  }),
});

// dao #34 : la hiérarchie portefeuille voyage dans le contrat `/state`.
state = Object.freeze({ ...state, portfolioSummary });

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
    loadPnlHistory: async (_agentName: string) => {
      await wait();
      return pnlHistory;
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
