import type { TradingCycleContext } from "@dodash/models";
import { describe, expect, it } from "vitest";

import type { PersistedTradingMachine } from "../src/machine-session.js";
import { resolveCycleInvocation } from "../src/state.js";

const context = (overrides: Partial<TradingCycleContext> = {}): TradingCycleContext => ({
  agentId: "agent-1",
  strategyIds: ["rsi-reversion"],
  permissions: { canControl: true, canTrade: true },
  cycleId: "cycle-old",
  triggeredAt: 100,
  nextWakeAt: null,
  marketSnapshotId: null,
  indicatorsId: null,
  signalsId: null,
  decisionId: null,
  clientOrderId: null,
  exchangeOrderId: null,
  orderMayBeInFlight: false,
  authorizationExpiresAt: null,
  shutdownMode: "none",
  outcome: "RUNNING",
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
