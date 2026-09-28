import type { TradingCycleContext } from "@dodash/models";
import { describe, expect, it } from "vitest";

import type { PersistedTradingMachine } from "../src/machine-session.js";
import { parseAgentConfiguration } from "../src/configuration.js";
import { INITIAL_AGENT_STATE, toAgentStateSnapshot } from "../src/state.js";
import * as stateModule from "../src/state.js";

const { resolveCycleInvocation } = stateModule;

const context = (overrides: Partial<TradingCycleContext> = {}): TradingCycleContext => ({
  agentId: "agent-1",
  strategyIds: ["rsi-reversion"],
  permissions: { canControl: true, canTrade: true },
  cycleId: "cycle-old",
  triggeredAt: 100,
  nextWakeAt: null,
  marketSnapshotId: null,
  accountSnapshotId: null,
  lastDecisionCandleClosedAt: null,
  indicatorsId: null,
  signalsId: null,
  decisionId: null,
  clientOrderId: null,
  exchangeOrderId: null,
  orderMayBeInFlight: false,
  authorizationExpiresAt: null,
  shutdownMode: "none",
  killRequestId: null,
  killCompleted: false,
  outcome: "RUNNING",
  terminalFailure: false,
  lastError: null,
  maxMarketStalenessMs: 90_000,
  retryLimits: {
    schedule: 3,
    marketData: 3,
    authorization: 2,
    execution: 1,
    reconciliation: 4,
    persistence: 5,
  },
  attempts: {
    schedule: 0,
    marketData: 0,
    authorization: 0,
    execution: 0,
    reconciliation: 0,
    persistence: 0,
  },
  ...overrides,
});

const machine = (
  value: string,
  overrides: Partial<TradingCycleContext> = {},
): PersistedTradingMachine => ({ value, context: context(overrides) });

describe("resolveCycleInvocation", () => {
  it("creates a fresh identity only when an alarm starts from waiting", () => {
    expect(resolveCycleInvocation(machine("waiting"), true, 200, "cycle-new")).toEqual({
      loadCycleId: null,
      cycleId: "cycle-new",
      triggeredAt: 200,
    });
  });

  it("restores the persisted identity after a mid-cycle wake", () => {
    expect(
      resolveCycleInvocation(machine("fetchingMarketData"), true, 200, "cycle-new"),
    ).toEqual({
      loadCycleId: "cycle-old",
      cycleId: "cycle-old",
      triggeredAt: 100,
    });
  });

  it("does not attach a stop-between-cycles to the previous cycle", () => {
    expect(
      resolveCycleInvocation(machine("cancelling"), false, 200, "cycle-new", null),
    ).toEqual({
      loadCycleId: null,
      cycleId: "cycle-old",
      triggeredAt: 100,
    });
  });
});

describe("live start continuity", () => {
  const liveConfiguration = (productId: "GRT-USD" | "MANA-USD") => {
    const result = parseAgentConfiguration({ productId, executionMode: "live" });
    if (!result.ok) throw new Error("invalid live fixture");
    return result.value;
  };

  const resolve = (productId: "GRT-USD" | "MANA-USD") => {
    const exported = stateModule as Record<string, unknown>;
    expect(typeof exported.resolveLiveStartContinuity).toBe("function");
    if (typeof exported.resolveLiveStartContinuity !== "function") return null;
    return (
      exported.resolveLiveStartContinuity as (
        current: Record<string, unknown>,
        next: ReturnType<typeof liveConfiguration>,
      ) => Record<string, unknown>
    )(
      {
        configuration: liveConfiguration("GRT-USD"),
        machine: machine("stopped", { lastDecisionCandleClosedAt: 123_000 }),
        portfolio: { cash: 9_400, positionQuantity: 100, averagePrice: 0.006 },
        dailyRiskWindow: { utcDayStart: 86_400_000, openingEquity: 10_000 },
        dailyPnl: -540,
        lastTradeAt: 120_000,
        previousIndicators: null,
        lastCycle: null,
      },
      liveConfiguration(productId),
    );
  };

  it("preserves the live portfolio and decision candle for the same product", () => {
    expect(resolve("GRT-USD")).toEqual({
      portfolio: { cash: 9_400, positionQuantity: 100, averagePrice: 0.006 },
      dailyRiskWindow: { utcDayStart: 86_400_000, openingEquity: 10_000 },
      dailyPnl: -540,
      lastTradeAt: 120_000,
      previousIndicators: null,
      lastCycle: null,
      lastDecisionCandleClosedAt: 123_000,
    });
  });

  it("starts a distinct live product from its configured capital", () => {
    expect(resolve("MANA-USD")).toEqual({
      portfolio: { cash: 10_000, positionQuantity: 0, averagePrice: 0 },
      dailyRiskWindow: null,
      dailyPnl: 0,
      lastTradeAt: null,
      previousIndicators: null,
      lastCycle: null,
      lastDecisionCandleClosedAt: null,
    });
  });
});

describe("daily risk cycle boundaries", () => {
  const call = (
    name: "resolveCycleDailyRiskStart" | "resolveCycleDailyRiskCompletion",
    ...args: readonly unknown[]
  ) => {
    const exported = stateModule as Record<string, unknown>;
    expect(typeof exported[name]).toBe("function");
    if (typeof exported[name] !== "function") return null;
    return (exported[name] as (...values: readonly unknown[]) => unknown)(...args);
  };

  it("leaves a new live UTC window unset until Coinbase establishes equity", () => {
    expect(
      call("resolveCycleDailyRiskStart", "live", null, 0, 86_400_000, 10_000),
    ).toEqual({ window: null, dailyPnl: 0 });

    expect(
      call(
        "resolveCycleDailyRiskStart",
        "live",
        { utcDayStart: 0, openingEquity: 20_000 },
        -500,
        86_400_000,
        10_000,
      ),
    ).toEqual({
      window: { utcDayStart: 0, openingEquity: 20_000 },
      dailyPnl: -500,
    });
  });

  it("never seeds a live completion from local equity after reconciliation fails", () => {
    expect(
      call(
        "resolveCycleDailyRiskCompletion",
        "live",
        null,
        0,
        86_400_000,
        10_000,
      ),
    ).toEqual({ window: null, dailyPnl: 0 });
  });

  const mark = (price: number) => ({
    price,
    source: "COINBASE_CANDLE_CLOSE" as const,
    timeframe: "ONE_DAY",
    candleClosedAt: 86_400_000,
    maxMarketStalenessMs: 7_200_000,
  });
  const valuation = (
    portfolio: { cash: number; positionQuantity: number; averagePrice: number },
    price: number | null,
    asOf: number,
  ) => stateModule.paperValuationFor("paper", portfolio, price === null ? null : mark(price), asOf);

  it("opens paper windows from the dated valuation, never from average price (daily-risk.md §3)", () => {
    const portfolio = { cash: 9_000, positionQuantity: 0.01, averagePrice: 100_000 };
    expect(
      call("resolveCycleDailyRiskStart", "paper", null, 0, 86_400_000 + 46_000, valuation(portfolio, 90_000, 86_400_000 + 46_000)),
    ).toEqual({
      window: { utcDayStart: 86_400_000, openingEquity: 9_900 },
      dailyPnl: 0,
    });
  });

  it("carries the paper window unchanged when no mark is available (open position)", () => {
    const portfolio = { cash: 9_000, positionQuantity: 0.01, averagePrice: 100_000 };
    const current = { utcDayStart: 0, openingEquity: 9_990.29 };
    expect(
      call("resolveCycleDailyRiskStart", "paper", current, -9.71, 86_400_000 + 46_000, valuation(portfolio, null, 86_400_000 + 46_000)),
    ).toEqual({ window: current, dailyPnl: -9.71 });
    expect(
      call("resolveCycleDailyRiskCompletion", "paper", null, 0, 86_400_000 + 46_000, valuation(portfolio, null, 86_400_000 + 46_000)),
    ).toEqual({ window: null, dailyPnl: 0 });
  });

  it("keeps dailyPnl constant across failed cycles at constant portfolio and mark", () => {
    // Reproduit la série AE BTC-USD 26-09 → 28-09 : deux échecs consécutifs
    // puis reprise. Avant l'amendement, l'équité retombait au coût (+9,71 / 0).
    const portfolio = { cash: 9_625.71, positionQuantity: 0.0043214386, averagePrice: 86_612.26 };
    const day = 86_400_000;
    const opening = call("resolveCycleDailyRiskCompletion", "paper", null, 0, day + 46_000, valuation(portfolio, 84_416.65, day + 46_000)) as { window: unknown; dailyPnl: number };
    const afterFail1 = call("resolveCycleDailyRiskCompletion", "paper", opening.window, opening.dailyPnl, day + 3_600_000, valuation(portfolio, 84_416.65, day + 3_600_000)) as { window: unknown; dailyPnl: number };
    const afterFail2 = call("resolveCycleDailyRiskCompletion", "paper", afterFail1.window, afterFail1.dailyPnl, day + 7_200_000, valuation(portfolio, 84_416.65, day + 7_200_000)) as { window: unknown; dailyPnl: number };
    expect(afterFail1.dailyPnl).toBe(0);
    expect(afterFail2.dailyPnl).toBe(0);
    expect(afterFail2.window).toEqual(opening.window);
  });

  it("treats perp like live: reconciled real PnL is kept, never local equity", () => {
    expect(
      call(
        "resolveCycleDailyRiskStart",
        "perp",
        { utcDayStart: 0, openingEquity: 20_000 },
        -500,
        86_400_000,
        10_000,
      ),
    ).toEqual({
      window: { utcDayStart: 0, openingEquity: 20_000 },
      dailyPnl: -500,
    });

    expect(
      call(
        "resolveCycleDailyRiskCompletion",
        "perp",
        { utcDayStart: 0, openingEquity: 20_000 },
        -750,
        86_400_000,
        10_000,
      ),
    ).toEqual({
      window: { utcDayStart: 0, openingEquity: 20_000 },
      dailyPnl: -750,
    });
  });
});

describe("paper valuation state projection (DAO #62)", () => {
  it("marks the post-cycle portfolio from dated market data and never falls back to average price", () => {
    const parsed = parseAgentConfiguration({ productId: "BTC-USD", executionMode: "paper" });
    if (!parsed.ok) throw new Error("invalid paper fixture");
    const state = {
      ...INITIAL_AGENT_STATE,
      configuration: parsed.value,
      portfolio: { cash: 100, positionQuantity: 2, averagePrice: 40 },
      lastPaperMark: {
        price: 50,
        source: "COINBASE_CANDLE_CLOSE" as const,
        timeframe: "FIVE_MINUTE",
        candleClosedAt: 900,
        maxMarketStalenessMs: 100,
      },
    };
    const summary = { ok: true as const, value: { kind: "single-product" as const } };
    const fresh = toAgentStateSnapshot(state, summary, 1_000);
    expect(fresh.paperValuation).toMatchObject({
      ok: true,
      value: {
        equity: 200,
        markPrice: 50,
        candleClosedAt: 900,
        ageMs: 100,
        quality: "fresh",
      },
    });

    const withoutMark = toAgentStateSnapshot(
      { ...state, lastPaperMark: null },
      summary,
      1_000,
    );
    expect(withoutMark.paperValuation).toMatchObject({
      ok: true,
      value: { equity: null, markPrice: null, quality: "unavailable" },
    });
  });
});
