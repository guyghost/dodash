import { setup, getNextSnapshot } from "xstate";
import type { P7LedgerState } from "./p7-prospective-ledger.js";
import type { P7BenchmarkEntries } from "./p7-prospective-benchmark-entry.js";
import { isP7MarkBooks, type P7MarkState, type P7HourlyObservation, type P7MarkEvidence } from "./p7-prospective-marks.js";
import { valueP7Liquidation, consolidateP7Marks, type P7LiquidationMark } from "./p7-prospective-pricing.js";
const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
type Product = typeof PRODUCTS[number];
type Phase = "expected" | "requested" | "observed";
export interface P7EventMarkSlot {
  readonly markId: string; readonly kind: "AFTER_FILL" | "FINAL"; readonly fillSequence: number | null;
  readonly expectedAt: number; readonly phase: Phase; readonly requestedAt: number | null;
  readonly portfolios: P7LedgerState["portfolios"] | null; readonly benchmarks: P7BenchmarkEntries | null;
  readonly observation: P7HourlyObservation | null; readonly benchmarkObservation: P7HourlyObservation | null;
}
export interface P7EventMarkState {
  readonly active: boolean; readonly lastRecordedAt: number;
  readonly lastSequences: Readonly<Record<Product, string | null>>;
  readonly slots: Readonly<Record<string, P7EventMarkSlot>>;
}
export const emptyP7EventMarks = (): P7EventMarkState => ({ active: false, lastRecordedAt: 0,
  lastSequences: { "BTC-USD": null, "ETH-USD": null }, slots: {} });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, allowed: readonly string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every((k) => allowed.includes(k));
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const emptySlot = (markId: string, expectedAt: number, fillSequence: number | null): P7EventMarkSlot => ({
  markId, kind: fillSequence === null ? "FINAL" : "AFTER_FILL", fillSequence, expectedAt, phase: "expected", requestedAt: null,
  portfolios: null, benchmarks: null, observation: null, benchmarkObservation: null,
});
/** Derived from an actual durable fill, never a caller-provided fill signal. */
export const expectP7AfterFill = (state: P7EventMarkState, sequence: number, at: number): P7EventMarkState => {
  if (!state.active) return state;
  const markId = `fill-${sequence}`;
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !time(at) || at < state.lastRecordedAt || state.slots[markId] !== undefined) throw new Error("INVALID_AFTER_FILL_EXPECTATION");
  return { ...state, lastRecordedAt: at, slots: { ...state.slots, [markId]: emptySlot(markId, at, sequence) } };
};
export const hasP7AfterFillBlocker = (state: P7EventMarkState): boolean => state.active && Object.values(state.slots).some((s) =>
  s.kind === "FINAL" ? s.phase === "requested" : (!s.observation?.consolidated.available || !s.benchmarkObservation?.consolidated.available));
export const p7EventMarkMachine = setup({ types: { context: {} as Record<string, never>, events: {} as { type: "REQUEST" | "OBSERVE" } } })
  .createMachine({ id: "p7EventMark", context: {}, initial: "expected", states: {
    expected: { on: { REQUEST: "requested" } }, requested: { on: { OBSERVE: "observed" } }, observed: { type: "final" },
  } });

export const applyP7EventMarkCommand = (state: P7EventMarkState, ledger: P7LedgerState, benchmarks: P7BenchmarkEntries,
  hourly: P7MarkState, benchmarkHourly: P7MarkState, jointMode: boolean, hasFills: boolean, input: unknown, at: number):
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly value: { readonly state: P7EventMarkState; readonly receipt: P7EventMarkSlot } } => {
  const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });
  if (!record(input) || !keys(input, ["campaignId", "commandId", "markId", "event"]) || input.campaignId !== ledger.manifest.campaignId ||
    !id(input.commandId) || !id(input.markId) || !record(input.event) || !time(at) || at < Math.max(ledger.lastRecordedAt, state.lastRecordedAt)) return fail("INVALID_EVENT_MARK_COMMAND");
  const event = input.event, markId = input.markId;
  if (!["REGISTER_EVENT_MARKS", "REQUEST_EVENT_MARK", "OBSERVE_EVENT_MARK"].includes(String(event.type)) ||
    !keys(event, event.type === "OBSERVE_EVENT_MARK" ? ["type", "books"] : ["type"])) return fail("INVALID_EVENT_MARK_COMMAND");
  if (event.type === "REGISTER_EVENT_MARKS") {
    if (state.active || !jointMode || !benchmarks.active || hasFills || markId !== "FINAL" || at >= ledger.manifest.endAt) return fail("EVENT_MARK_MODE_NOT_READY");
    const slot = emptySlot("FINAL", ledger.manifest.endAt, null);
    return { ok: true, value: { state: { ...state, active: true, lastRecordedAt: at, slots: { FINAL: slot } }, receipt: slot } };
  }
  const current = state.slots[markId];
  if (!state.active || current === undefined || current.phase === "observed") return fail("INVALID_EVENT_MARK_PHASE");
  let slot = current, lastSequences = { ...state.lastSequences };
  if (event.type === "REQUEST_EVENT_MARK") {
    if (current.kind === "AFTER_FILL" && !PRODUCTS.every((p) => ["initialized", "failed"].includes(benchmarks.products[p]?.phase ?? ""))) return fail("BENCHMARK_BOOTSTRAP_INCOMPLETE");
    if (current.phase !== "expected" || at < ledger.manifest.startAt || at >= ledger.manifest.endAt ||
      (current.kind === "AFTER_FILL" ? at < current.expectedAt : at < ledger.manifest.endAt - 3_600_000)) return fail("EVENT_MARK_WINDOW_EXPIRED");
    slot = { ...current, requestedAt: at, portfolios: structuredClone(ledger.portfolios), benchmarks: structuredClone(benchmarks) };
  } else {
    if (current.phase !== "requested" || current.requestedAt === null || current.portfolios === null || current.benchmarks === null) return fail("INVALID_EVENT_MARK_PHASE");
    if (current.kind === "FINAL" ? at < ledger.manifest.endAt : at >= ledger.manifest.endAt) return fail("EVENT_MARK_WINDOW_EXPIRED");
    if (JSON.stringify(current.portfolios) !== JSON.stringify(ledger.portfolios) || JSON.stringify(current.benchmarks.products) !== JSON.stringify(benchmarks.products)) return fail("EVENT_MARK_PORTFOLIO_CHANGED");
    if (!isP7MarkBooks(event.books)) return fail("INVALID_MARK_EVIDENCE");
    const books = event.books, asOf = current.kind === "FINAL" ? ledger.manifest.endAt : at;
    const bhPortfolios = { ...ledger.portfolios };
    for (const product of PRODUCTS) bhPortfolios[product] = { cash: benchmarks.products[product]?.portfolio?.cash ?? 0,
      positionQuantity: benchmarks.products[product]?.portfolio?.positionQuantity ?? 0, version: 0 };
    const observe = (benchmark: boolean): P7HourlyObservation => {
      const marks = PRODUCTS.map((productId): P7LiquidationMark => {
        const book = books[productId]?.book, leg = benchmarks.products[productId];
        const unavailable = (reason: string): P7LiquidationMark => ({ productId, asOf, available: false, equity: null, reason });
        if (benchmark && leg?.phase !== "initialized") return unavailable("BENCHMARK_NOT_INITIALIZED");
        const portfolio = benchmark ? { ...ledger.portfolios[productId], ...leg?.portfolio, version: 0 } : ledger.portfolios[productId];
        if (benchmark) bhPortfolios[productId] = portfolio;
        let previous: string | null = null;
        const entrySequence = record(leg?.book) && typeof leg.book.sequence === "string" && leg.phase === "initialized" ? leg.book.sequence : null;
        for (const sequence of [state.lastSequences[productId], hourly.lastSequences[productId], benchmarkHourly.lastSequences[productId], ledger.lastSequences[productId], entrySequence])
          if (sequence !== null && (previous === null || BigInt(sequence) > BigInt(previous))) previous = sequence;
        const mark = valueP7Liquidation({ productId, sourceProfileId: ledger.manifest.sourceProfileId, clockVerified: ledger.manifest.clockVerified,
          campaignStartAt: ledger.manifest.startAt, campaignEndAt: ledger.manifest.endAt, previousSequence: previous }, book, portfolio, asOf);
        if (mark.available && mark.source !== "CASH") {
          if (!record(book) || book.requestedAt !== current.requestedAt) return unavailable("REQUEST_CHECKPOINT_MISMATCH");
          if (!time(book.sourceObservedAt) || at - book.sourceObservedAt > 5_000) return unavailable("STALE_AT_USE");
          lastSequences[productId] = book.sequence as string;
        }
        return mark;
      });
      return { asOf, marks, consolidated: consolidateP7Marks(marks), portfolios: structuredClone(benchmark ? bhPortfolios : ledger.portfolios) };
    };
    slot = { ...current, observation: observe(false), benchmarkObservation: observe(true) };
  }
  const phase = getNextSnapshot(p7EventMarkMachine, p7EventMarkMachine.resolveState({ value: current.phase, context: {} }),
    { type: event.type === "REQUEST_EVENT_MARK" ? "REQUEST" : "OBSERVE" }).value as Phase;
  slot = { ...slot, phase };
  return { ok: true, value: { state: { ...state, lastRecordedAt: at, lastSequences, slots: { ...state.slots, [markId]: slot } }, receipt: slot } };
};

export const checkP7EventMarkClock = (slot: P7EventMarkSlot, books: Readonly<Record<Product, P7MarkEvidence | null>> | null,
  endAt: number, recordedAt: number, checkedAt: number): string | null => {
  if (!time(checkedAt) || checkedAt < recordedAt) return "COMMIT_CLOCK_INVALID";
  if (slot.phase !== "observed") return checkedAt >= endAt ? "EVENT_MARK_WINDOW_EXPIRED" : null;
  if (slot.kind === "AFTER_FILL" && checkedAt >= endAt) return "EVENT_MARK_WINDOW_EXPIRED";
  for (const observation of [slot.observation, slot.benchmarkObservation]) for (const mark of observation?.marks ?? []) {
    if (!mark.available || mark.source === "CASH") continue;
    const book = books?.[mark.productId]?.book;
    if (!record(book) || !time(book.sourceObservedAt) || checkedAt - book.sourceObservedAt > 5_000) return "MARK_EXPIRED_BEFORE_COMMIT";
  }
  return null;
};
