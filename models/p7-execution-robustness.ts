import { assign, setup } from "xstate";

export const P7_EXECUTION_SCENARIOS = Object.freeze([
  { id: "C0", execution: "DECISION_CLOSE", feeBps: 60, slippageBps: 2 },
  { id: "O0", execution: "NEXT_OPEN", feeBps: 60, slippageBps: 2 },
  { id: "O1", execution: "NEXT_OPEN", feeBps: 60, slippageBps: 10 },
  { id: "O2", execution: "NEXT_OPEN", feeBps: 60, slippageBps: 50 },
  { id: "O3", execution: "NEXT_OPEN", feeBps: 120, slippageBps: 10 },
  { id: "O4", execution: "NEXT_OPEN", feeBps: 120, slippageBps: 50 },
] as const);

export interface P7RobustnessMetrics {
  readonly id: string;
  readonly netReturn: number;
  readonly cagr: number;
  readonly maxDrawdown: number;
  readonly windowDrawdowns: readonly number[];
}
export interface P7RobustnessAssessment {
  readonly verdict: "INVALID_EVIDENCE" | "REFERENCE_MISMATCH" | "ROBUST_IN_TESTED_SCENARIOS" | "SENSITIVE_TO_ASSUMPTIONS";
  readonly scenarios: readonly { readonly id: string; readonly verdict: "WITHIN_CONSTRAINT" | "OUTSIDE_CONSTRAINT" }[];
}
const validDrawdown = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;
const withinConstraint = (row: P7RobustnessMetrics): boolean => row.netReturn > 0 &&
  row.maxDrawdown <= 0.5 && row.windowDrawdowns.every((n) => n <= 0.5);

export const assessP7ExecutionRobustness = (rows: readonly P7RobustnessMetrics[]): P7RobustnessAssessment => {
  if (rows.length !== 6 || !P7_EXECUTION_SCENARIOS.every((s) => rows.filter((r) => r.id === s.id).length === 1) ||
    rows.some((r) => !Number.isFinite(r.netReturn) || r.netReturn <= -1 || !Number.isFinite(r.cagr) || r.cagr <= -1 ||
      !validDrawdown(r.maxDrawdown) || r.windowDrawdowns.length !== 5 || !r.windowDrawdowns.every(validDrawdown))) {
    return { verdict: "INVALID_EVIDENCE", scenarios: [] };
  }
  const reference = rows.find((r) => r.id === "C0");
  if (reference === undefined || !withinConstraint(reference) || Math.abs(reference.cagr - 0.52) > 0.08 || Math.abs(reference.maxDrawdown - 0.456) > 0.06) {
    return { verdict: "REFERENCE_MISMATCH", scenarios: [] };
  }
  const scenarios = P7_EXECUTION_SCENARIOS.map((s) => {
    const row = rows.find((r) => r.id === s.id);
    return { id: s.id, verdict: row !== undefined && withinConstraint(row) ? "WITHIN_CONSTRAINT" as const : "OUTSIDE_CONSTRAINT" as const };
  });
  return { verdict: scenarios.every((r) => r.verdict === "WITHIN_CONSTRAINT") ? "ROBUST_IN_TESTED_SCENARIOS" : "SENSITIVE_TO_ASSUMPTIONS", scenarios };
};

export const p7ExecutionRobustnessMachine = setup({
  types: {
    context: {} as { assessment: P7RobustnessAssessment | null },
    events: {} as { type: "START" } | { type: "DATA_READY" } | { type: "REPLAY_READY"; results: readonly P7RobustnessMetrics[] } | { type: "FAILED" },
  },
  actions: { assess: assign(({ event }) => event.type === "REPLAY_READY" ? { assessment: assessP7ExecutionRobustness(event.results) } : {}) },
  guards: { valid: ({ context }) => context.assessment?.verdict === "ROBUST_IN_TESTED_SCENARIOS" || context.assessment?.verdict === "SENSITIVE_TO_ASSUMPTIONS" },
}).createMachine({
  id: "p7ExecutionRobustness", initial: "idle", context: { assessment: null },
  on: { FAILED: ".invalid" },
  states: {
    idle: { on: { START: "validating" } },
    validating: { on: { DATA_READY: "replaying" } },
    replaying: { on: { REPLAY_READY: { target: "assessing", actions: "assess" } } },
    assessing: { always: [{ guard: "valid", target: "completed" }, { target: "invalid" }] },
    completed: { type: "final" }, invalid: { type: "final" },
  },
});
