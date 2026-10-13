import type { PersistedTradingMachine } from "../src/machine-session.js";
import { describe, expect, it } from "vitest";

import { createTradingMachineSession } from "../src/machine-session.js";

describe("TradingMachineSession", () => {
  it("restores a persisted XState phase and continues with typed events", () => {
    const input = { agentId: "agent-1", strategyIds: ["rsi-reversion"] };
    const first = createTradingMachineSession(input);
    first.send({
      type: "START_REQUESTED",
      permissions: { canControl: true, canTrade: true },
    });
    first.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 1_000 });
    const persisted = first.record;
    first.stop();

    const restored = createTradingMachineSession(input, persisted);
    expect(restored.phase).toBe("waiting");
    restored.send({
      type: "KILL_SWITCH_ENGAGED",
      permissions: { canControl: true, canTrade: true },
      controlId: "kill-session-1",
    });
    expect(restored.phase).toBe("cancelling");
    restored.stop();
  });

  it("normalizes fail-closed account-control fields from a legacy snapshot", () => {
    const input = { agentId: "agent-1", strategyIds: ["rsi-reversion"] };
    const current = createTradingMachineSession(input);
    current.send({
      type: "START_REQUESTED",
      permissions: { canControl: true, canTrade: true },
    });
    current.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 1_000 });
    const persisted = current.record;
    current.stop();

    const legacyContext = { ...persisted.context } as Record<string, unknown>;
    delete legacyContext.accountSnapshotId;
    delete legacyContext.killRequestId;
    delete legacyContext.killCompleted;
    delete legacyContext.terminalFailure;
    delete legacyContext.marketAdmission;

    const restored = createTradingMachineSession(input, {
      value: persisted.value,
      context: legacyContext,
    } as unknown as PersistedTradingMachine);

    expect(restored.context.accountSnapshotId).toBeNull();
    expect(restored.context.killRequestId).toBeNull();
    expect(restored.context.killCompleted).toBe(false);
    expect(restored.context.terminalFailure).toBe(false);
    expect(restored.context.marketAdmission).toBeNull();
    restored.stop();
  });

  it("preserves a durable admission across restart and clears it only for a new cycle", () => {
    const input = { agentId: "paper", strategyIds: ["rsi-reversion"] };
    const session = createTradingMachineSession(input);
    session.send({ type: "START_REQUESTED", permissions: { canControl: true, canTrade: true } });
    session.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 100 });
    session.send({ type: "ALARM_FIRED", cycleId: "cycle-a", triggeredAt: 100 });
    session.send({ type: "ACCOUNT_RECONCILED", snapshotId: "account" });
    session.send({ type: "MARKET_DATA_READY", snapshotId: "market", candleClosedAt: 90, evaluatedAt: 105 });
    const record = session.record;
    session.stop();
    const restored = createTradingMachineSession(input, record);
    expect(restored.context.marketAdmission).toEqual({ cycleId: "cycle-a", candleClosedAt: 90, evaluatedAt: 105 });
    restored.send({ type: "INDICATORS_COMPUTED", indicatorsId: "ind" });
    restored.send({ type: "STRATEGIES_EVALUATED", signalsId: "signals" });
    restored.send({ type: "ALLOCATION_COMPLETED", decisionId: "decision", orderCount: 0 });
    restored.send({ type: "PERSIST_SUCCEEDED" });
    restored.send({ type: "SCHEDULE_SUCCEEDED", nextWakeAt: 200 });
    expect(restored.context.marketAdmission?.evaluatedAt).toBe(105);
    restored.send({ type: "ALARM_FIRED", cycleId: "cycle-b", triggeredAt: 200 });
    expect(restored.context.marketAdmission).toBeNull();
    expect(restored.context.lastDecisionCandleClosedAt).toBe(90);
    restored.stop();
  });

  it("drops an admission attached to a different cycle on restoration", () => {
    const input = { agentId: "paper", strategyIds: [] };
    const session = createTradingMachineSession(input);
    const record = session.record;
    session.stop();
    const restored = createTradingMachineSession(input, {
      ...record, context: { ...record.context, marketAdmission: { cycleId: "different", candleClosedAt: 0, evaluatedAt: 0 } },
    });
    expect(restored.context.marketAdmission).toBeNull();
    restored.stop();
  });
});
