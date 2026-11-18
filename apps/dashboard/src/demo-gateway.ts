import type {
  AgentStateView,
  CycleView,
  DashboardGateway,
  PaperValuationView,
  PnlHistoryView,
  PortfolioSummaryView,
  StartConfiguration,
} from "./dashboard-api.js";

const wait = async (): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, 260));

const startedAt = Date.now();
const valuation = (
  asOf: number,
  equity: number | null,
  markPrice: number | null,
  exposureNotional = markPrice === null ? 0 : markPrice,
  ageMs: number | null = markPrice === null ? null : 60_000,
): PaperValuationView => ({
  asOf,
  equity,
  exposureNotional,
  exposureQuality: "fresh",
  markPrice,
  markSource: markPrice === null ? null : "COINBASE_CANDLE_CLOSE",
  timeframe: markPrice === null ? null : "ONE_MINUTE",
  candleClosedAt: ageMs === null ? null : asOf - ageMs,
  ageMs,
  quality: markPrice === null ? "unavailable" : "fresh",
});
let state: AgentStateView = Object.freeze({
  enabled: true,
  phase: "waiting",
  updatedAt: startedAt,
  configuration: Object.freeze({
    productId: "BTC-USD",
    timeframe: "ONE_MINUTE",
    strategyIds: Object.freeze(["breakout", "ema-cross", "rsi-reversion"]),
    intervalSeconds: 60,
    executionMode: "paper",
  }),
  portfolio: Object.freeze({
    cash: 8_642.14,
    positionQuantity: 0.0184,
    averagePrice: 61_284.42,
  }),
  dailyPnl: 172.38,
  nextWakeAt: startedAt + 60_000,
  lastTradeAt: startedAt - 886_000,
  lastCycle: Object.freeze({
    cycleId: "cycle-01J6A2J8X7",
    outcome: "ORDER_CONFIRMED",
    marketPrice: 63_912.18,
    signalCount: 3,
    completedAt: startedAt - 886_000,
  }),
  portfolioSummary: Object.freeze({ kind: "single-product" as const }),
  paperValuation: Object.freeze({
    ok: true as const,
    value: Object.freeze(valuation(startedAt, 9_817.52, 63_912.18, 1_175.98)),
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

let pnlHistory: PnlHistoryView = Object.freeze({
  equityCurve: Object.freeze([
    { t: startedAt - 2_690_000, equity: 9_680.0, valuation: valuation(startedAt - 2_690_000, 9_680.0, 62_850), productId: "BTC-USD" },
    { t: startedAt - 2_090_000, equity: 9_812.4, valuation: valuation(startedAt - 2_090_000, 9_812.4, 63_400), productId: "BTC-USD" },
    { t: startedAt - 1_490_000, equity: 9_774.02, valuation: valuation(startedAt - 1_490_000, 9_774.02, 63_402.11), productId: "ETH-USD" },
    { t: startedAt - 1_190_000, equity: 9_869.76, valuation: valuation(startedAt - 1_190_000, 9_869.76, 63_712), productId: "ETH-USD" },
    { t: startedAt - 890_000, equity: 9_964.56, valuation: valuation(startedAt - 890_000, 9_964.56, 63_912.18), productId: "BTC-USD" },
  ]),
  cycles: Object.freeze([
    Object.freeze({
      cycleId: "cycle-01J6A2J8X7",
      productId: "BTC-USD",
      triggeredAt: startedAt - 890_000,
      completedAt: startedAt - 886_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 63_912.18,
      valuation: valuation(startedAt - 886_000, 9_964.56, 63_912.18),
      side: "BUY" as const,
      quantity: 0.0184,
      fillPrice: 63_912.18,
      fee: 0.12,
      realizedPnl: null,
      slippageBps: 0,
    }),
    Object.freeze({
      cycleId: "cycle-01J6A1TB4M",
      productId: "ETH-USD",
      triggeredAt: startedAt - 1_190_000,
      completedAt: startedAt - 1_187_000,
      outcome: "NO_ACTION",
      marketPrice: 63_402.11,
      valuation: valuation(startedAt - 1_187_000, 9_869.76, 63_402.11),
      side: null,
      quantity: null,
      fillPrice: null,
      fee: null,
      realizedPnl: null,
      slippageBps: null,
    }),
    Object.freeze({
      cycleId: "cycle-01J6A14QPC",
      productId: "SOL-USD",
      triggeredAt: startedAt - 1_490_000,
      completedAt: startedAt - 1_486_000,
      outcome: "RISK_REJECTED",
      marketPrice: 63_118.4,
      valuation: valuation(startedAt - 1_486_000, 9_774.02, 63_118.4),
      side: null,
      quantity: null,
      fillPrice: null,
      fee: null,
      realizedPnl: null,
      slippageBps: null,
    }),
    Object.freeze({
      cycleId: "cycle-01J69Z8K1P",
      productId: "ETH-USD",
      triggeredAt: startedAt - 2_090_000,
      completedAt: startedAt - 2_086_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 63_400.0,
      valuation: valuation(startedAt - 2_086_000, 9_812.4, 63_400.0),
      side: "SELL" as const,
      quantity: 0.016,
      fillPrice: 63_400.0,
      fee: 0.1,
      realizedPnl: 132.4,
      slippageBps: 0,
    }),
    Object.freeze({
      cycleId: "cycle-01J69X2M9A",
      productId: "BTC-USD",
      triggeredAt: startedAt - 2_690_000,
      completedAt: startedAt - 2_687_000,
      outcome: "ORDER_CONFIRMED",
      marketPrice: 62_850.0,
      valuation: valuation(startedAt - 2_687_000, 9_680.0, 62_850.0),
      side: "BUY" as const,
      quantity: 0.016,
      fillPrice: 62_850.0,
      fee: 0.1,
      realizedPnl: null,
      slippageBps: 0,
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
  asOf: startedAt,
  products: Object.freeze([
    Object.freeze({
      productId: "BTC-USD",
      phase: "waiting",
      status: "running" as const,
      cash: 5_204.11,
      positionQuantity: 0.0184,
      averagePrice: 61_284.42,
      marketPrice: 63_912.18,
      valuation: valuation(startedAt, 6_380.09, 63_912.18, 1_175.98),
      grossExposure: 1_175.98,
      exposureQuality: "fresh",
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
      valuation: valuation(startedAt, 4_377.7687, 3_121.77, 967.7487),
      grossExposure: 967.75,
      exposureQuality: "fresh",
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
      valuation: valuation(startedAt, 1_380.57, 146.9, 352.56),
      grossExposure: 352.56,
      exposureQuality: "fresh",
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
    equity: 12_138.4287,
    valuationQuality: "fresh",
    grossExposure: 2_496.29,
    exposureQuality: "fresh",
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
        const now = Date.now();
        const isFill = cycles.length % 2 === 1;
        const nextMark = Number((63_948.72 + (isFill ? 142.5 : -38.2)).toFixed(2));
        const nextEquity = Number((9_964.56 + cycles.length * 14.2).toFixed(2));
        const cycleId = `cycle-demo-${cycles.length + 1}`;
        const cycle: CycleView = Object.freeze({
          cycleId,
          triggeredAt: now - 1_200,
          completedAt: now,
          phase: "scheduling",
          outcome: isFill ? "ORDER_CONFIRMED" : "NO_ACTION",
        });
        cycles = Object.freeze([cycle, ...cycles].slice(0, 12));
        const nextVal = valuation(now, nextEquity, nextMark, 1_195.2, 4_000);
        pnlHistory = Object.freeze({
          ...pnlHistory,
          equityCurve: Object.freeze([
            ...pnlHistory.equityCurve,
            { t: now, equity: nextEquity, valuation: nextVal },
          ]),
          cycles: Object.freeze([
            Object.freeze({
              cycleId,
              triggeredAt: now - 1_200,
              completedAt: now,
              outcome: isFill ? "ORDER_CONFIRMED" : "NO_ACTION",
              marketPrice: nextMark,
              valuation: nextVal,
              side: isFill ? ("BUY" as const) : null,
              quantity: isFill ? 0.004 : null,
              fillPrice: isFill ? nextMark : null,
              fee: isFill ? 0.03 : null,
              realizedPnl: isFill ? 14.2 : null,
              slippageBps: isFill ? 0 : null,
            }),
            ...pnlHistory.cycles,
          ]),
        });
        state = nextState({
          enabled: true,
          phase: "waiting",
          dailyPnl: Number((state.dailyPnl + (isFill ? 14.2 : 0)).toFixed(2)),
          nextWakeAt: now + 300_000,
          lastCycle: Object.freeze({
            cycleId: cycle.cycleId,
            outcome: cycle.outcome,
            marketPrice: nextMark,
            signalCount: 3,
            completedAt: cycle.completedAt ?? now,
          }),
          paperValuation: Object.freeze({
            ok: true as const,
            value: Object.freeze(nextVal),
          }),
        });
      }
      return state;
    },
  });
