import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { normalizeMarketAdmission, projectDecisionAdmission } from "./decision-admission-telemetry.js";
import { tradingCycleMachine } from "./trading-cycle.machine.js";

const context = () => ({
  ...createActor(tradingCycleMachine, { input: { agentId: "paper", strategyIds: [] } }).getSnapshot().context,
  cycleId: "cycle-a", triggeredAt: 100, lastDecisionCandleClosedAt: 90,
  marketAdmission: { cycleId: "cycle-a", candleClosedAt: 90, evaluatedAt: 105 },
});

describe("durable market admission projection", () => {
  it("publishes the admission instant, not completion time or valuation", () => {
    expect(projectDecisionAdmission(context())).toEqual({
      cycleId: "cycle-a", triggeredAt: 100, decisionAdmissionStatus: "ADMITTED",
      decisionCandleClosedAt: 90, decisionEvaluatedAt: 105,
    });
  });
  it.each([undefined, null, {}, { cycleId: "other", candleClosedAt: 90, evaluatedAt: 105 },
    { cycleId: "cycle-a", candleClosedAt: 91, evaluatedAt: 105 },
    { cycleId: "cycle-a", candleClosedAt: 90, evaluatedAt: NaN },
    { cycleId: "cycle-a", candleClosedAt: 90, evaluatedAt: 99 },
    { cycleId: "cycle-a", candleClosedAt: 90, evaluatedAt: 100_000 },
  ])("drops invalid/legacy metadata without inventing admission: %j", (value) => {
    expect(normalizeMarketAdmission(value, context())).toBeNull();
  });
  it("treats missing metadata as unobserved, not a proven absence", () => {
    expect(projectDecisionAdmission({ ...context(), marketAdmission: null }).decisionAdmissionStatus).toBe("UNOBSERVED");
  });
  it("keeps epoch zero as an observed timestamp", () => {
    const input = { ...context(), triggeredAt: 0, lastDecisionCandleClosedAt: 0,
      marketAdmission: { cycleId: "cycle-a", candleClosedAt: 0, evaluatedAt: 0 } };
    expect(projectDecisionAdmission(input).decisionAdmissionStatus).toBe("ADMITTED");
    expect(projectDecisionAdmission(input).decisionEvaluatedAt).toBe(0);
  });
  it("clears cycle admission on RESET without discarding candle deduplication", () => {
    const actor = createActor(tradingCycleMachine, {
      input: { agentId: "paper", strategyIds: [] },
      snapshot: tradingCycleMachine.resolveState({ value: "failed", context: context() }),
    }).start();
    actor.send({ type: "RESET", permissions: { canControl: true, canTrade: true } });
    expect(actor.getSnapshot().context.marketAdmission).toBeNull();
    expect(actor.getSnapshot().context.lastDecisionCandleClosedAt).toBe(90);
    actor.stop();
  });
});
