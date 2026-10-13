/** Pure routing contract for grid wakes, retries and controls (cycle-wake.md). */
export interface CycleWakePlan {
  readonly triggerAlarm: boolean;
  readonly pendingAlarm: boolean;
}

export const planCycleWake = (phase: string, triggerAlarm: boolean): CycleWakePlan => ({
  triggerAlarm: triggerAlarm && phase === "waiting",
  pendingAlarm: triggerAlarm && phase !== "waiting",
});

/** Evaluate against the latest state, after publishing the resumed cycle. */
export const shouldStartPendingCycle = (plan: CycleWakePlan, phase: string | null): boolean =>
  plan.pendingAlarm && phase === "waiting";
