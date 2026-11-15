import { describe, expect, it } from "vitest";
import { planCycleWake, shouldStartPendingCycle } from "./cycle-wake.js";

describe("cycle wake routing", () => {
  it("starts an alarm immediately only from waiting", () => {
    expect(planCycleWake("waiting", true)).toEqual({ triggerAlarm: true, pendingAlarm: false });
  });

  it("resumes a pending cycle before consuming a grid wake", () => {
    expect(planCycleWake("retryingMarketData", true)).toEqual({ triggerAlarm: false, pendingAlarm: true });
  });

  it.each(["waiting", "retryingMarketData", "cancelling"])("does not create alarms on a retry/control wake (%s)", (phase) => {
    expect(planCycleWake(phase, false)).toEqual({ triggerAlarm: false, pendingAlarm: false });
  });

  it.each(["retryingMarketData", "stopped", "halted", "failed", "cancelling"])("never chains an alarm from %s", (phase) => {
    expect(shouldStartPendingCycle({ triggerAlarm: false, pendingAlarm: true }, phase)).toBe(false);
  });

  it("chains once after the resumed cycle closes", () => {
    expect(shouldStartPendingCycle(planCycleWake("retryingMarketData", true), "waiting")).toBe(true);
    expect(shouldStartPendingCycle(planCycleWake("waiting", true), "waiting")).toBe(false);
    expect(shouldStartPendingCycle(planCycleWake("retryingMarketData", false), "waiting")).toBe(false);
  });
});
