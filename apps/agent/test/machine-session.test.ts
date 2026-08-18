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
    });
    expect(restored.phase).toBe("cancelling");
    restored.stop();
  });
});
