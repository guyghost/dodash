import { executePaperOrder, type PaperPortfolio } from "@dodash/paper-execution";
import { err, ok, type Candle, type OrderIntent } from "@dodash/domain";
import type { WorkflowError } from "@dodash/models";
import { describe, expect, it } from "vitest";

import { parseAgentConfiguration } from "../src/configuration.js";
import { runTradingCycle } from "../src/interpreter.js";
import { createTradingMachineSession } from "../src/machine-session.js";
import type {
  CycleArtifacts,
  MarketSnapshot,
  TradingCycleEffects,
} from "../src/types.js";

const candlesFromCloses = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: Math.max(0.01, close - 1),
    close,
    volume: 10,
  }));

const readyMachine = (agentId: string, strategyIds: readonly string[]) => {
  const session = createTradingMachineSession({ agentId, strategyIds });
  session.send({
    type: "START_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 360_000 });
  const record = session.record;
  session.stop();
  return record;
};

const cancellingMachine = (agentId: string, strategyIds: readonly string[]) => {
  const session = createTradingMachineSession({ agentId, strategyIds });
  session.send({
    type: "START_REQUESTED",
    permissions: { canControl: true, canTrade: true },
  });
  session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 360_000 });
  session.send({
    type: "KILL_SWITCH_ENGAGED",
    permissions: { canControl: true, canTrade: true },
    controlId: "kill-persist-failure",
  });
  const record = session.record;
  session.stop();
  return record;
};

const configuration = () => {
  const result = parseAgentConfiguration({
    productId: "BTC-USD",
    strategyIds: ["rsi-reversion"],
    candleLimit: 6,
    intervalSeconds: 60,
    indicators: {
      rsiPeriod: 5,
      emaFastPeriod: 3,
      emaSlowPeriod: 5,
      atrPeriod: 3,
      historicalVolatilityPeriod: 2,
      momentumPeriod: 1,
      returnPeriods: [1],
      vwapPeriod: 2,
      relativeVolumePeriod: 1,
      volumeSpikeThreshold: 2,
      volumeTrendPeriod: 2,
      trendStrengthPeriod: 1,
    },
    risk: {
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
      maxGrossExposure: 20_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    },
    broker: { feeBps: 0, slippageBps: 0 },
  });
  if (!result.ok) throw new Error("invalid test configuration");
  return result.value;
};

const effectsFor = (
  market: MarketSnapshot,
  initialPortfolio: PaperPortfolio,
) => {
  const checkpoints: CycleArtifacts[] = [];
  const intents: OrderIntent[] = [];
  let persistedCycles = 0;
  const effects: TradingCycleEffects = {
    reconcileAccount: async (portfolio, observedAt) =>
      ok({
        snapshotId: `paper:${observedAt}`,
        observedAt,
        portfolio,
        accountEquity:
          portfolio.cash + portfolio.positionQuantity * portfolio.averagePrice,
        otherExposureNotional: 0,
      }),
    fetchMarketData: async () => ok(market),
    ensureSchedule: async () => ok({ nextWakeAt: 420_000 }),
    checkpoint: async (artifacts) => {
      checkpoints.push(artifacts);
      return ok(undefined);
    },
    persistMachine: async () => undefined,
    persistOrderIntent: async (_cycleId, intent) => {
      intents.push(intent);
      return ok(undefined);
    },
    authorize: async () => ok({ issuedAt: 360_000, expiresAt: 420_000 }),
    submitOrder: async (
      intent,
      _riskDecision,
      _authorization,
      price,
      portfolio,
      triggeredAt,
    ) => {
      const execution = executePaperOrder(portfolio, intent, price, triggeredAt, {
        feeBps: 0,
        slippageBps: 0,
      });
      if (!execution.ok) {
        const error: WorkflowError = {
          phase: "execution",
          code: "ORDER_REJECTED",
          retryable: false,
        };
        return { status: "REJECTED", error };
      }
      return {
        status: "CONFIRMED",
        exchangeOrderId: execution.value.trade.fill.exchangeOrderId,
        portfolio: execution.value.portfolio,
        fill: execution.value.trade.fill,
      };
    },
    reconcileOrder: async () =>
      ok({
        status: "REJECTED" as const,
        error: {
          phase: "execution" as const,
          code: "ORDER_REJECTED" as const,
          retryable: false,
        },
      }),
    cancelCurrentEffect: async () => ok(undefined),
    persistCycle: async () => {
      persistedCycles += 1;
      return ok(undefined);
    },
  };
  return {
    checkpoints,
    effects,
    initialPortfolio,
    intents,
    get persistedCycles() {
      return persistedCycles;
    },
  };
};

describe("runTradingCycle", () => {
  it("persists a terminal cancellation failure before entering failed", async () => {
    const config = configuration();
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 10, 10, 10, 10, 10]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );

    const result = await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine: cancellingMachine("agent-1", config.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 360_000,
      cycleId: "cycle-cancel-failed",
      triggerAlarm: false,
      effects: {
        ...fixture.effects,
        cancelCurrentEffect: async () =>
          err({
            phase: "cancellation",
            code: "CANCELLATION_FAILURE",
            retryable: false,
          }),
      },
    });

    expect(result.machine.value).toBe("failed");
    expect(result.machine.context.terminalFailure).toBe(true);
    expect(fixture.persistedCycles).toBe(1);
  });

  it("executes an oversold paper order through the XState phases", async () => {
    const config = configuration();
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 9, 8, 7, 6, 5]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );

    const result = await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine: readyMachine("agent-1", config.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 360_000,
      cycleId: "cycle-1",
      triggerAlarm: true,
      effects: fixture.effects,
    });

    expect(result.machine.value).toBe("waiting");
    expect(result.machine.context.outcome).toBe("ORDER_CONFIRMED");
    expect(result.portfolio.positionQuantity).toBeGreaterThan(0);
    expect(fixture.intents).toHaveLength(1);
    expect(fixture.persistedCycles).toBe(1);
    expect(fixture.checkpoints.length).toBeGreaterThan(5);
  });

  it("fails terminally with a freshly reconciled flat account when protection fails", async () => {
    const config = configuration();
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const flattened = { cash: 9_950, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 9, 8, 7, 6, 5]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );

    const result = await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine: readyMachine("agent-1", config.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 360_000,
      cycleId: "cycle-protection-failed",
      triggerAlarm: true,
      effects: {
        ...fixture.effects,
        submitOrder: async () => ({
          status: "UNKNOWN",
          exchangeOrderId: "parent-order-1",
          error: {
            phase: "execution",
            code: "ORDER_OUTCOME_UNKNOWN",
            retryable: true,
          },
        }),
        reconcileOrder: async () =>
          ok({
            status: "PROTECTION_FAILED" as const,
            exchangeOrderId: "parent-order-1",
            protectiveOrderId: "protective-order-1",
            portfolio: flattened,
            fill: null,
            accountEquity: 9_950,
            otherExposureNotional: 0,
            observedAt: 360_001,
            error: {
              phase: "reconciliation" as const,
              code: "INVALID_RESPONSE" as const,
              retryable: false,
            },
          }),
      },
    });

    expect(result.machine.value).toBe("failed");
    expect(result.machine.context.terminalFailure).toBe(true);
    expect(result.machine.context.outcome).toBe("FAILED");
    expect(result.portfolio).toEqual(flattened);
    expect(result.dailyPnl).toBe(-50);
    expect(result.artifacts?.execution).toMatchObject({
      exchangeOrderId: "parent-order-1",
      protectiveOrderId: "protective-order-1",
    });
  });

  it("persists NO_ACTION without creating an order", async () => {
    const config = configuration();
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 10, 10, 10, 10, 10]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );
    const result = await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine: readyMachine("agent-1", config.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 360_000,
      cycleId: "cycle-2",
      triggerAlarm: true,
      effects: fixture.effects,
    });
    expect(result.machine.context.outcome).toBe("NO_ACTION");
    expect(result.portfolio).toEqual(portfolio);
    expect(fixture.intents).toHaveLength(0);
    expect(fixture.persistedCycles).toBe(1);
  });

  it("does not recompute or trade a decision candle already persisted", async () => {
    const config = configuration();
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 9, 8, 7, 6, 5]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );
    const persisted = readyMachine("agent-1", config.strategyIds);
    const machine = {
      ...persisted,
      context: {
        ...persisted.context,
        lastDecisionCandleClosedAt: 360_000,
      },
    };

    const result = await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine,
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 420_000,
      cycleId: "cycle-duplicate-candle",
      triggerAlarm: true,
      effects: fixture.effects,
    });

    expect(result.machine.context.outcome).toBe("NO_ACTION");
    expect(result.portfolio).toEqual(portfolio);
    expect(result.previousIndicators).toBeNull();
    expect(fixture.intents).toHaveLength(0);
    expect(fixture.persistedCycles).toBe(1);
  });

  it("sizes active signals from the configured target notional", async () => {
    const config = {
      ...configuration(),
      sizingPolicy: {
        type: "TARGET_SIGNAL_NOTIONAL" as const,
        targetSignalNotional: 1_000,
        confidenceCalibration: "POWER_THIRD" as const,
      },
    };
    const portfolio = { cash: 10_000, positionQuantity: 0, averagePrice: 0 };
    const fixture = effectsFor(
      {
        productId: config.productId,
        timeframe: config.timeframe,
        candles: candlesFromCloses([10, 9, 8, 7, 6, 5]),
        source: "coinbase",
        cached: false,
      },
      portfolio,
    );

    await runTradingCycle({
      agentId: "agent-1",
      configuration: config,
      machine: readyMachine("agent-1", config.strategyIds),
      artifacts: null,
      previousIndicators: null,
      portfolio,
      dailyPnl: 0,
      lastTradeAt: null,
      triggeredAt: 360_000,
      cycleId: "cycle-target-sized",
      triggerAlarm: true,
      effects: fixture.effects,
    });

    expect(fixture.intents).toHaveLength(1);
    expect(fixture.intents[0]?.quantity).toBe(200);
  });
});
