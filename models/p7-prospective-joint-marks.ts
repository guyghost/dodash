import { applyP7MarkCommand, type P7MarkState, type P7MarkSlot } from "./p7-prospective-marks.js";
import type { P7LedgerState } from "./p7-prospective-ledger.js";
import type { P7BenchmarkEntries } from "./p7-prospective-benchmark-entry.js";
import { consolidateP7Marks, type P7LiquidationMark } from "./p7-prospective-pricing.js";

const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
export interface P7JointMarkSlot extends P7MarkSlot {
  readonly benchmarkObservation: P7MarkSlot["observation"];
}
/** One common request/checkpoint and two immutable portfolio snapshots. */
export const applyP7JointMarkCommand = (marks: P7MarkState, benchmarkMarks: P7MarkState, ledger: P7LedgerState,
  entries: P7BenchmarkEntries, input: unknown, recordedAt: number):
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly value: {
    readonly state: P7MarkState; readonly benchmarkState: P7MarkState; readonly receipt: P7JointMarkSlot;
  } } => {
  if (!entries.active) return { ok: false, error: "INDEPENDENT_BENCHMARK_REQUIRED" };
  const p7 = applyP7MarkCommand(marks, ledger, input, recordedAt);
  if (!p7.ok) return p7;
  const portfolios = { ...ledger.portfolios }, lastSequences = { ...benchmarkMarks.lastSequences };
  for (const product of PRODUCTS) {
    const leg = entries.products[product];
    portfolios[product] = { ...ledger.portfolios[product], cash: leg?.portfolio?.cash ?? 0,
      positionQuantity: leg?.portfolio?.positionQuantity ?? 0, version: 0 };
    const executionSequence = ledger.lastSequences[product];
    if (executionSequence !== null && (lastSequences[product] === null || BigInt(executionSequence) > BigInt(lastSequences[product])))
      lastSequences[product] = executionSequence;
    if (leg?.phase === "initialized" && leg.book !== null && typeof leg.book === "object" && "sequence" in leg.book && typeof leg.book.sequence === "string") {
      const prior = lastSequences[product];
      if (prior === null || BigInt(leg.book.sequence) > BigInt(prior)) lastSequences[product] = leg.book.sequence;
    }
  }
  const bh = applyP7MarkCommand({ ...benchmarkMarks, lastSequences }, { ...ledger, portfolios, lastSequences }, input, recordedAt);
  if (!bh.ok) return bh;
  let slot = bh.value.receipt;
  if (slot.observation !== null) {
    const observation = slot.observation;
    const values = observation.marks.map((mark): P7LiquidationMark => entries.products[mark.productId]?.phase === "initialized" ? mark :
      { productId: mark.productId, asOf: recordedAt, available: false, equity: null, reason: "BENCHMARK_NOT_INITIALIZED" });
    slot = { ...slot, observation: { ...observation, marks: values, consolidated: consolidateP7Marks(values) } };
  }
  return { ok: true, value: { state: p7.value.state,
    benchmarkState: { ...bh.value.state, slots: { ...bh.value.state.slots, [String(slot.scheduledAt)]: slot } },
    receipt: { ...p7.value.receipt, benchmarkObservation: slot.observation } } };
};
