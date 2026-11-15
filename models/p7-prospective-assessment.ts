import { setup, getNextSnapshot } from "xstate";
import type { P7LedgerState } from "./p7-prospective-ledger.js";
import type { P7BenchmarkEntries } from "./p7-prospective-benchmark-entry.js";
import type { P7EventMarkState } from "./p7-prospective-event-marks.js";
import type { P7LocalCampaignState } from "./p7-prospective-campaign-safety.js";
import { reportP7MarkCoverage, type P7MarkState, type P7HourlyObservation } from "./p7-prospective-marks.js";
export interface P7AssessmentSnapshot {
  readonly observation: "SYNTHETIC_LOCAL_PREPARATION"; readonly state: P7LedgerState;
  readonly markState: P7MarkState; readonly benchmarkMarkState: P7MarkState;
  readonly benchmarkEntries: P7BenchmarkEntries; readonly eventMarkState: P7EventMarkState;
  readonly campaignState: P7LocalCampaignState; readonly jointMode: boolean;
  readonly entries: readonly { readonly sequence: number; readonly recordedAt: number; readonly command?: unknown; readonly resolution?: unknown }[];
}
type Checkpoint = 30 | 90 | 180;
const DAY = 86_400_000, PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const p7AssessmentMachine = setup({ types: { context: {} as Record<string, never>,
  events: {} as { type: "REPORT" | "INVALID" | "INCONCLUSIVE" | "FAVORABLE" | "UNFAVORABLE" } } }).createMachine({
  id: "p7LocalAssessment", context: {}, initial: "waiting", states: {
    waiting: { on: { REPORT: "reported", INVALID: "invalid", INCONCLUSIVE: "inconclusive", FAVORABLE: "favorable", UNFAVORABLE: "unfavorable" } },
    reported: { type: "final" }, invalid: { type: "final" }, inconclusive: { type: "final" }, favorable: { type: "final" }, unfavorable: { type: "final" },
  },
});
const observations = (marks: P7MarkState, events: P7EventMarkState, benchmark: boolean, cutoff: number): P7HourlyObservation[] =>
  [...Object.values(marks.slots).flatMap((s) => s.observation === null ? [] : [s.observation]),
    ...Object.values(events.slots).flatMap((s) => (benchmark ? s.benchmarkObservation : s.observation) === null ? [] :
      [(benchmark ? s.benchmarkObservation : s.observation) as P7HourlyObservation])]
    .filter((o) => o.asOf <= cutoff && o.consolidated.available).sort((a, b) => a.asOf - b.asOf);
const metrics = (values: readonly P7HourlyObservation[], final: P7HourlyObservation | null, previousDrawdown = 0) => {
  let peak = 20_000, maxDrawdown = previousDrawdown;
  for (const observation of values) if (observation.consolidated.available) {
    const equity = observation.consolidated.equity;
    if (!Number.isFinite(equity) || equity < 0) throw new Error("INVALID_ASSESSMENT_EQUITY");
    peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  if (!final?.consolidated.available) return { economics: null, maxDrawdown };
  return { economics: { equity: final.consolidated.equity, netReturn: final.consolidated.equity / 20_000 - 1,
    sampledThroughAt: final.asOf, maxDrawdown, drawdownScope: "SAMPLED_NOT_CONTINUOUS" as const }, maxDrawdown };
};
const exposure = (values: readonly P7HourlyObservation[]) => {
  const fractions = values.flatMap((o) => {
    if (!o.consolidated.available || o.marks.length !== 2 || !o.marks.every((m) => m.available)) return [];
    const invested = o.marks.reduce((sum, m) => sum + (m.available ? m.liquidablePositionValue : 0), 0);
    return [o.consolidated.equity === 0 ? 0 : invested / o.consolidated.equity];
  });
  return { basis: "SAMPLED_LIQUIDABLE_POSITION_VALUE_OVER_EQUITY", samples: fractions.length,
    mean: fractions.length === 0 ? null : fractions.reduce((sum, v) => sum + v, 0) / fractions.length,
    min: fractions.length === 0 ? null : Math.min(...fractions), max: fractions.length === 0 ? null : Math.max(...fractions),
    timeWeighted: false };
};

/** Input is a shell-revalidated snapshot, not an independently authenticated source. */
export const assessP7CampaignSnapshot = (snapshot: P7AssessmentSnapshot, checkpoint: Checkpoint) => {
  if (snapshot.observation !== "SYNTHETIC_LOCAL_PREPARATION" || ![30, 90, 180].includes(checkpoint)) throw new Error("INVALID_ASSESSMENT_SCOPE");
  const { state, campaignState, eventMarkState } = snapshot, { manifest } = state;
  const cutoff = manifest.startAt + checkpoint * DAY;
  const p7Coverage = reportP7MarkCoverage(snapshot.markState, manifest, cutoff);
  const bhCoverage = reportP7MarkCoverage(snapshot.benchmarkMarkState, manifest, cutoff);
  const reasons: string[] = [], outcomes: Record<string, number> = {};
  let reconciled = 0, admitted = 0, unobserved = 0, unresolved = 0, lateExpectations = 0;
  const expectations = new Map<string, number>();
  const ids = new Set<string>(); let journalValid = true;
  for (const [index, entry] of snapshot.entries.entries()) {
    if (entry.sequence !== index + 1) journalValid = false;
    if (!record(entry.command)) continue;
    const command = entry.command;
    if (typeof command.commandId !== "string" || ids.has(command.commandId)) journalValid = false;
    else ids.add(command.commandId);
    if (record(command.event) && command.event.type === "EXPECT") expectations.set(`${command.productId}:${command.candleClosedAt}`, entry.recordedAt);
  }
  for (let i = 0; i < checkpoint; i++) for (const product of PRODUCTS) {
    const close = manifest.startAt + i * DAY, key = `${product}:${close}`, slot = state.slots[key], expectedAt = expectations.get(key);
    if (expectedAt === undefined || expectedAt > close + 7_200_000) lateExpectations++;
    if (slot === undefined) { unobserved++; continue; }
    if (slot.phase === "terminal" && slot.outcome !== null) {
      reconciled++; outcomes[slot.outcome.kind] = (outcomes[slot.outcome.kind] ?? 0) + 1;
    } else unresolved++;
    if (slot.admission !== null && slot.admission.evaluatedAt >= close && slot.admission.evaluatedAt <= close + 7_200_000) admitted++;
  }
  const daily = { expected: checkpoint * 2, reconciled, admitted, unobserved, unresolved, lateExpectations,
    admissionCoverage: admitted / (checkpoint * 2), outcomes };
  const benchmarkComplete = PRODUCTS.every((p) => snapshot.benchmarkEntries.products[p]?.phase === "initialized");
  const afterFillSlots = Object.values(eventMarkState.slots).filter((s) => s.kind === "AFTER_FILL" && s.expectedAt < cutoff);
  const afterFillMissing = afterFillSlots.filter((s) => !s.observation?.consolidated.available || !s.benchmarkObservation?.consolidated.available).length;
  const pendingResponses = Object.values(snapshot.markState.slots).some((s) => s.phase === "requested") ||
    Object.values(eventMarkState.slots).some((s) => s.phase === "requested") || Object.values(snapshot.benchmarkEntries.products).some((s) => s?.phase === "requested") ||
    Object.values(state.slots).some((s) => s.phase === "requested");
  const final = eventMarkState.slots.FINAL;
  const finalComplete = final?.phase === "observed" && final.observation?.asOf === manifest.endAt && final.benchmarkObservation?.asOf === manifest.endAt &&
    final.observation.consolidated.available && final.benchmarkObservation.consolidated.available &&
    PRODUCTS.every((p) => final.observation?.portfolios[p].cash === state.portfolios[p].cash &&
      final.observation?.portfolios[p].positionQuantity === state.portfolios[p].positionQuantity && final.observation?.portfolios[p].version === state.portfolios[p].version &&
      final.benchmarkObservation?.portfolios[p].cash === snapshot.benchmarkEntries.products[p]?.portfolio?.cash &&
      final.benchmarkObservation?.portfolios[p].positionQuantity === snapshot.benchmarkEntries.products[p]?.portfolio?.positionQuantity);
  const p7Observations = observations(snapshot.markState, eventMarkState, false, cutoff);
  const bhObservations = observations(snapshot.benchmarkMarkState, eventMarkState, true, cutoff);
  const invalidEquity = [...p7Observations, ...bhObservations].some((o) => o.consolidated.available && (!Number.isFinite(o.consolidated.equity) || o.consolidated.equity < 0));
  const invariantBreach = !journalValid || invalidEquity || !Number.isFinite(campaignState.maxDrawdown) || campaignState.maxDrawdown < 0 || campaignState.phase === "invalid" || PRODUCTS.some((p) =>
    !Number.isFinite(state.portfolios[p].cash) || state.portfolios[p].cash < 0 || !Number.isFinite(state.portfolios[p].positionQuantity) || state.portfolios[p].positionQuantity < 0);
  if (invariantBreach) reasons.push("ACCOUNTING_OR_JOURNAL_INVARIANT_BREACH");
  if (!snapshot.jointMode || !eventMarkState.active || campaignState.boundAt === null || !manifest.clockVerified) reasons.push("LOCAL_MODES_NOT_READY");
  if (reconciled !== daily.expected || lateExpectations !== 0) reasons.push("DAILY_RECONCILIATION_INCOMPLETE");
  if (daily.admissionCoverage < 0.99) reasons.push("DAILY_ADMISSION_COVERAGE_BELOW_99_PERCENT");
  if ((p7Coverage.coverage ?? 0) < 0.99 || (bhCoverage.coverage ?? 0) < 0.99) reasons.push("HOURLY_COVERAGE_BELOW_99_PERCENT");
  if (p7Coverage.proofGapExceeded || bhCoverage.proofGapExceeded) reasons.push("HISTORICAL_PROOF_GAP_EXCEEDED");
  if (!benchmarkComplete) reasons.push("BENCHMARK_INITIALIZATION_INCOMPLETE");
  if (afterFillMissing > 0) reasons.push("AFTER_FILL_PROOF_INCOMPLETE");
  if (pendingResponses) reasons.push("RESPONSE_UNOBSERVED");
  if (checkpoint === 180 && !finalComplete) reasons.push("FINAL_PROOF_INCOMPLETE");
  if (["suspended", "registered"].includes(campaignState.phase) || (campaignState.phase === "stopped" && !campaignState.reasons.includes("SAMPLED_DRAWDOWN_EXCEEDED")) ||
    campaignState.reasons.some((r) => r.includes("PROOF_GAP") || r === "LOCAL_OPERATOR_STOP" || r === "RESPONSE_UNOBSERVED_AT_RECOVERY")) reasons.push("CAMPAIGN_INTERRUPTED");
  const p7 = metrics(invalidEquity ? [] : p7Observations, invariantBreach ? null : checkpoint === 180 ? finalComplete ? final.observation : null : p7Observations.at(-1) ?? null,
    Number.isFinite(campaignState.maxDrawdown) ? campaignState.maxDrawdown : 0);
  const bh = metrics(invalidEquity ? [] : bhObservations, invariantBreach ? null : checkpoint === 180 ? finalComplete ? final.benchmarkObservation : null : bhObservations.at(-1) ?? null);
  const localQualified = reasons.length === 0;
  let syntheticVerdict: "INVALID_CAMPAIGN" | "INCONCLUSIVE" | "PROSPECTIVE_OBSERVATION_FAVORABLE" | "PROSPECTIVE_OBSERVATION_UNFAVORABLE" | null = null;
  if (checkpoint === 180) syntheticVerdict = invariantBreach ? "INVALID_CAMPAIGN" : p7.maxDrawdown > 0.5 || campaignState.reasons.includes("SAMPLED_DRAWDOWN_EXCEEDED") ?
    "PROSPECTIVE_OBSERVATION_UNFAVORABLE" : !localQualified || p7.economics === null ? "INCONCLUSIVE" :
      p7.economics.netReturn > 0 ? "PROSPECTIVE_OBSERVATION_FAVORABLE" : "PROSPECTIVE_OBSERVATION_UNFAVORABLE";
  const event = checkpoint !== 180 ? "REPORT" : syntheticVerdict === "INVALID_CAMPAIGN" ? "INVALID" : syntheticVerdict === "INCONCLUSIVE" ? "INCONCLUSIVE" :
    syntheticVerdict === "PROSPECTIVE_OBSERVATION_FAVORABLE" ? "FAVORABLE" : "UNFAVORABLE";
  const machinePhase = getNextSnapshot(p7AssessmentMachine, p7AssessmentMachine.resolveState({ value: "waiting", context: {} }), { type: event }).value;
  const p7Fees = Object.values(state.slots).reduce((sum, s) => sum + (s.candleClosedAt < cutoff && s.outcome?.kind === "SIMULATED_FILL" ? s.outcome.fee : 0), 0);
  const bhFees = PRODUCTS.reduce((sum, p) => sum + (snapshot.benchmarkEntries.products[p]?.fill?.fee ?? 0), 0);
  return { observation: "SYNTHETIC_LOCAL_PREPARATION" as const, checkpoint, cutoff, campaignId: manifest.campaignId,
    manifestSha256: manifest.manifestSha256, machinePhase, syntheticVerdict, prospectiveVerdict: null,
    technical: { localQualified, prospectiveQualified: false, reasons }, daily,
    coverage: { p7: p7Coverage, buyAndHold: bhCoverage }, afterFill: { expected: afterFillSlots.length, missing: afterFillMissing },
    economics: { evaluableLocally: localQualified, scope: checkpoint === 180 ? "PRIMARY_LOCAL_SIMULATION" : "DESCRIPTIVE_ONLY",
      p7: p7.economics, buyAndHold: bh.economics, cash: { equity: 20_000, netReturn: 0 },
      underperformsBuyAndHold: p7.economics !== null && bh.economics !== null ? p7.economics.netReturn < bh.economics.netReturn : null,
      realizedSimulatedFees: { p7: p7Fees, buyAndHold: bhFees }, feeBps: 60, slippageBps: 2 },
    exposure: { p7: exposure(invalidEquity ? [] : p7Observations), buyAndHold: exposure(invalidEquity ? [] : bhObservations), cash: 0 },
    openInventory: { p7: state.portfolios, buyAndHold: Object.fromEntries(PRODUCTS.map((p) => [p,
      { phase: snapshot.benchmarkEntries.products[p]?.phase ?? "UNOBSERVED", portfolio: snapshot.benchmarkEntries.products[p]?.portfolio ?? null }])) },
    limitations: ["SYNTHETIC_NOT_PROSPECTIVE", "NO_REMOTE_EXPORT_OR_SOURCE_AUTHENTICATION", "NO_GO_OR_LIVE_AUTHORIZATION", "SAMPLED_DRAWDOWN"] };
};
