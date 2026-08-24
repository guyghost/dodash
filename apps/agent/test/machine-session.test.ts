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

    const restored = createTradingMachineSession(input, {
      value: persisted.value,
      context: legacyContext,
    } as unknown as PersistedTradingMachine);

    expect(restored.context.accountSnapshotId).toBeNull();
    expect(restored.context.killRequestId).toBeNull();
    expect(restored.context.killCompleted).toBe(false);
    expect(restored.context.terminalFailure).toBe(false);
    restored.stop();
  });
});
