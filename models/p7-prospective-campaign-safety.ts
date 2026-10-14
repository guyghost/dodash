import { setup, getNextSnapshot } from "xstate";
import type { P7LedgerState } from "./p7-prospective-ledger.js";
import { reportP7MarkCoverage, type P7MarkState } from "./p7-prospective-marks.js";

type Phase = "registered" | "localObserving" | "suspended" | "stopped" | "invalid" | "ended";
export interface P7LocalCampaignState {
  readonly phase: Phase; readonly boundAt: number | null; readonly lastEvaluatedAt: number;
  readonly maxDrawdown: number; readonly reasons: readonly string[];
}
export interface P7LocalCampaignCommand {
  readonly campaignId: string; readonly commandId: string;
  readonly event: { readonly type: "BEGIN_LOCAL_SIMULATION" | "CHECK_LOCAL_SAFETY" | "RECOVER_LOCAL" | "STOP_LOCAL" };
}
const timestamp = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const record = (n: unknown): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n);
export const initialP7LocalCampaign = (registeredAt: number): P7LocalCampaignState => ({
  phase: "registered", boundAt: null, lastEvaluatedAt: registeredAt, maxDrawdown: 0, reasons: [],
});
export const p7LocalCampaignMachine = setup({ types: {
  context: {} as Record<string, never>,
  events: {} as { readonly type: "BEGIN" | "SUSPEND" | "STOP" | "INVALIDATE" | "END" },
} }).createMachine({ id: "p7LocalCampaign", context: {}, initial: "registered",
  on: { INVALIDATE: ".invalid" }, states: {
    registered: { on: { BEGIN: "localObserving" } },
    localObserving: { on: { SUSPEND: "suspended", STOP: "stopped", END: "ended" } },
    suspended: { on: { STOP: "stopped", END: "ended" } },
    stopped: {}, invalid: {}, ended: {},
  },
});
const transition = (state: P7LocalCampaignState, type: "BEGIN" | "SUSPEND" | "STOP" | "INVALIDATE" | "END", reason?: string): P7LocalCampaignState => {
  const snapshot = p7LocalCampaignMachine.resolveState({ value: state.phase, context: {} });
  return { ...state, phase: getNextSnapshot(p7LocalCampaignMachine, snapshot, { type }).value as Phase,
    reasons: reason === undefined || state.reasons.includes(reason) ? state.reasons : [...state.reasons, reason] };
};
const validPortfolio = (p: P7LedgerState["portfolios"]["BTC-USD"]): boolean =>
  Number.isFinite(p.cash) && p.cash >= 0 && Number.isFinite(p.positionQuantity) && p.positionQuantity >= 0 && Number.isSafeInteger(p.version) && p.version >= 0;

/** Deterministic safety projection; never starts a real campaign or decides a verdict. */
export const evaluateP7LocalCampaignSafety = (state: P7LocalCampaignState, ledger: P7LedgerState, marks: P7MarkState,
  now: number, recovering = false, benchmarkPending = false, benchmarkMarks: P7MarkState | null = null): P7LocalCampaignState => {
  if (!timestamp(now) || now < Math.max(state.lastEvaluatedAt, ledger.lastRecordedAt, marks.lastRecordedAt, benchmarkMarks?.lastRecordedAt ?? 0)) throw new Error("INVALID_CAMPAIGN_CLOCK");
  let next = { ...state, lastEvaluatedAt: now };
  if (state.boundAt === null) return next;
  if (ledger.manifest.purpose !== "LOCAL_PREPARATION" || !Object.values(ledger.portfolios).every(validPortfolio))
    return transition(next, "INVALIDATE", "ACCOUNTING_INVARIANT_BREACH");
  const observations = Object.values(marks.slots).flatMap((s) => s.observation?.consolidated.available && s.observation.asOf <= now ? [s.observation] : []).sort((a, b) => a.asOf - b.asOf);
  let peak = 20_000, maxDrawdown = state.maxDrawdown;
  for (const observation of observations) {
    if (!observation.consolidated.available) continue;
    const equity = observation.consolidated.equity;
    if (!Number.isFinite(equity) || equity < 0) return transition(next, "INVALIDATE", "MARK_INVARIANT_BREACH");
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  next = { ...next, maxDrawdown };
  if (state.phase === "invalid") return next;
  if (maxDrawdown > 0.5 && state.phase !== "ended") return transition(next, "STOP", "SAMPLED_DRAWDOWN_EXCEEDED");
  if (state.phase === "stopped" || state.phase === "ended") return next;
  if (now >= ledger.manifest.endAt) return transition(next, "END", "PERIOD_ENDED");
  if (state.phase === "suspended") return next;
  if (reportP7MarkCoverage(marks, ledger.manifest, now).proofGapExceeded) return transition(next, "SUSPEND", "MARK_PROOF_GAP_EXCEEDED");
  if (benchmarkMarks !== null && reportP7MarkCoverage(benchmarkMarks, ledger.manifest, now).proofGapExceeded)
    return transition(next, "SUSPEND", "BENCHMARK_MARK_PROOF_GAP_EXCEEDED");
  if (recovering && (benchmarkPending || Object.values(marks.slots).some((s) => s.phase === "requested") || Object.values(ledger.slots).some((s) => s.phase === "requested")))
    return transition(next, "SUSPEND", "RESPONSE_UNOBSERVED_AT_RECOVERY");
  return next;
};

export const applyP7LocalCampaignCommand = (state: P7LocalCampaignState, ledger: P7LedgerState, marks: P7MarkState, input: unknown, now: number, benchmarkPending = false, benchmarkMarks: P7MarkState | null = null):
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly value: P7LocalCampaignState } => {
  const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });
  if (!record(input) || Object.keys(input).length !== 3 || !Object.keys(input).every((k) => ["campaignId", "commandId", "event"].includes(k)) ||
    input.campaignId !== ledger.manifest.campaignId || typeof input.commandId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId) ||
    !record(input.event) || Object.keys(input.event).length !== 1 || !["BEGIN_LOCAL_SIMULATION", "CHECK_LOCAL_SAFETY", "RECOVER_LOCAL", "STOP_LOCAL"].includes(String(input.event.type))) return fail("INVALID_LOCAL_CAMPAIGN_COMMAND");
  const type = (input as unknown as P7LocalCampaignCommand).event.type;
  if (!timestamp(now) || now < Math.max(state.lastEvaluatedAt, ledger.lastRecordedAt, marks.lastRecordedAt)) return fail("INVALID_CAMPAIGN_CLOCK");
  let next = state;
  if (type === "BEGIN_LOCAL_SIMULATION") {
    if (state.boundAt !== null || ledger.manifest.purpose !== "LOCAL_PREPARATION" || !ledger.manifest.clockVerified || now < ledger.manifest.startAt || now >= ledger.manifest.endAt) return fail("LOCAL_SIMULATION_NOT_READY");
    next = { ...transition(state, "BEGIN"), boundAt: now };
  } else if (type === "STOP_LOCAL") {
    if (state.boundAt === null || !["localObserving", "suspended"].includes(state.phase)) return fail("INVALID_CAMPAIGN_PHASE");
    next = transition(state, "STOP", "LOCAL_OPERATOR_STOP");
  }
  return { ok: true, value: evaluateP7LocalCampaignSafety(next, ledger, marks, now, type === "RECOVER_LOCAL", benchmarkPending, benchmarkMarks) };
};
