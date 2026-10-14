import { setup, getNextSnapshot } from "xstate";
import type { P7LedgerState, P7LedgerManifest } from "./p7-prospective-ledger.js";
import { valueP7Liquidation, consolidateP7Marks, type P7LiquidationMark } from "./p7-prospective-pricing.js";

const HOUR = 3_600_000;
const PRODUCTS = ["BTC-USD", "ETH-USD"] as const;
type Product = typeof PRODUCTS[number];
type Phase = "expected" | "requested" | "observed";
export interface P7MarkEvidence { readonly bodySha256: string; readonly book: unknown }
export interface P7MarkCommand {
  readonly campaignId: string; readonly commandId: string; readonly scheduledAt: number;
  readonly event: { readonly type: "EXPECT_MARK" } | { readonly type: "REQUEST_MARK" } |
    { readonly type: "OBSERVE_MARK"; readonly books: Readonly<Record<Product, P7MarkEvidence | null>> };
}
export interface P7HourlyObservation {
  readonly asOf: number; readonly marks: readonly P7LiquidationMark[];
  readonly consolidated: ReturnType<typeof consolidateP7Marks>;
  readonly portfolios: P7LedgerState["portfolios"];
}
export interface P7MarkSlot {
  readonly scheduledAt: number; readonly phase: Phase; readonly requestedAt: number | null;
  readonly observation: P7HourlyObservation | null;
}
export interface P7MarkState {
  readonly lastRecordedAt: number;
  readonly slots: Readonly<Record<string, P7MarkSlot>>;
  readonly lastSequences: Readonly<Record<Product, string | null>>;
}
export const emptyP7MarkState = (): P7MarkState => ({ lastRecordedAt: 0, slots: {}, lastSequences: { "BTC-USD": null, "ETH-USD": null } });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const keys = (v: object, names: readonly string[]): boolean => Object.keys(v).length === names.length && Object.keys(v).every((k) => names.includes(k));
const bookFields = ["productId", "sourceProfileId", "cacheStatus", "sequence", "requestedAt", "receivedAt", "sourceObservedAt", "bids", "asks"];
const evidence = (v: unknown): v is P7MarkEvidence | null => v === null || (record(v) && keys(v, ["bodySha256", "book"]) &&
  typeof v.bodySha256 === "string" && /^[a-f0-9]{64}$/.test(v.bodySha256) &&
  (!record(v.book) || (Object.keys(v.book).every((k) => bookFields.includes(k)) &&
    ![v.book.bids, v.book.asks].some((side) => Array.isArray(side) && side.some((level: unknown) => record(level) && !keys(level, ["price", "quantity"]))))));
const newest = (a: string | null, b: string | null): string | null => a === null ? b : b === null ? a : BigInt(a) >= BigInt(b) ? a : b;

export const p7HourlyMarkMachine = setup({ types: {
  context: {} as Record<string, never>,
  events: {} as { readonly type: "REQUEST_MARK" } | { readonly type: "OBSERVE_MARK" },
} }).createMachine({ id: "p7HourlyMark", context: {}, initial: "expected", states: {
  expected: { on: { REQUEST_MARK: "requested" } }, requested: { on: { OBSERVE_MARK: "observed" } }, observed: { type: "final" },
} });

/** Pure fact projection; never writes a fill, balance or portfolio version. */
export const applyP7MarkCommand = (state: P7MarkState, ledger: P7LedgerState, input: unknown, recordedAt: number):
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly value: { readonly state: P7MarkState; readonly receipt: P7MarkSlot } } => {
  const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });
  if (!record(input) || !keys(input, ["campaignId", "commandId", "scheduledAt", "event"]) || input.campaignId !== ledger.manifest.campaignId ||
    typeof input.commandId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId) ||
    !timestamp(input.scheduledAt) || input.scheduledAt % HOUR !== 0 || input.scheduledAt < ledger.manifest.startAt || input.scheduledAt >= ledger.manifest.endAt ||
    !record(input.event) || !timestamp(recordedAt) || recordedAt < Math.max(ledger.lastRecordedAt, state.lastRecordedAt)) return fail("INVALID_MARK_COMMAND");
  const event = input.event;
  if (!["EXPECT_MARK", "REQUEST_MARK", "OBSERVE_MARK"].includes(String(event.type)) ||
    !keys(event, event.type === "OBSERVE_MARK" ? ["type", "books"] : ["type"])) return fail("INVALID_MARK_COMMAND");
  const command = input as unknown as P7MarkCommand, key = String(command.scheduledAt);
  const current = state.slots[key];
  let slot: P7MarkSlot;
  let lastSequences = state.lastSequences;
  if (command.event.type === "EXPECT_MARK") {
    if (current !== undefined) return fail("INVALID_MARK_PHASE");
    slot = { scheduledAt: command.scheduledAt, phase: "expected", requestedAt: null, observation: null };
  } else {
    if (current === undefined || current.phase === "observed") return fail("INVALID_MARK_PHASE");
    if (recordedAt < command.scheduledAt || recordedAt >= command.scheduledAt + HOUR || recordedAt >= ledger.manifest.endAt) return fail("MARK_WINDOW_EXPIRED");
    if (command.event.type === "REQUEST_MARK") {
      if (current.phase !== "expected") return fail("INVALID_MARK_PHASE");
      slot = { ...current, requestedAt: recordedAt };
    } else {
      if (current.phase !== "requested" || current.requestedAt === null) return fail("INVALID_MARK_PHASE");
      const { books } = command.event;
      if (!record(books) || !keys(books, PRODUCTS) || !PRODUCTS.every((p) => evidence(books[p]))) return fail("INVALID_MARK_EVIDENCE");
      const sequences = { ...lastSequences };
      const marks = PRODUCTS.map((productId): P7LiquidationMark => {
        const book = books[productId]?.book;
        const mark = valueP7Liquidation({ productId, sourceProfileId: ledger.manifest.sourceProfileId, clockVerified: ledger.manifest.clockVerified,
          campaignStartAt: ledger.manifest.startAt, campaignEndAt: ledger.manifest.endAt,
          previousSequence: newest(lastSequences[productId], ledger.lastSequences[productId]) }, book, ledger.portfolios[productId], recordedAt);
        if (mark.available && mark.source !== "CASH") {
          if (!record(book) || book.requestedAt !== current.requestedAt) return { productId, asOf: recordedAt, available: false, equity: null, reason: "REQUEST_CHECKPOINT_MISMATCH" };
          sequences[productId] = book.sequence as string;
        }
        return mark;
      });
      lastSequences = sequences;
      slot = { ...current, observation: { asOf: recordedAt, marks, consolidated: consolidateP7Marks(marks),
        portfolios: { "BTC-USD": { ...ledger.portfolios["BTC-USD"] }, "ETH-USD": { ...ledger.portfolios["ETH-USD"] } } } };
    }
    const snapshot = p7HourlyMarkMachine.resolveState({ value: current.phase, context: {} });
    const phase = getNextSnapshot(p7HourlyMarkMachine, snapshot, { type: command.event.type }).value as Phase;
    if (phase === current.phase) return fail("INVALID_MARK_PHASE");
    slot = { ...slot, phase };
  }
  return { ok: true, value: { state: { lastRecordedAt: recordedAt, slots: { ...state.slots, [key]: slot }, lastSequences }, receipt: slot } };
};

export const planP7MarkRecovery = (state: P7MarkState, scheduledAt: number): { readonly action: string; readonly reason?: string } => {
  const slot = state.slots[String(scheduledAt)];
  if (slot?.phase === "requested") return { action: "SUSPEND", reason: "MARK_RESPONSE_UNOBSERVED" };
  return { action: slot?.phase === "observed" ? "DONE" : slot === undefined ? "EXPECT_MARK" : "RESUME_CHECKPOINT" };
};

export const evaluateP7MarkCommitClock = (command: P7MarkCommand, receipt: P7MarkSlot, manifest: P7LedgerManifest,
  recordedAt: number, checkedAt: number): string | null => {
  if (!timestamp(checkedAt) || checkedAt < recordedAt) return "COMMIT_CLOCK_INVALID";
  if (command.event.type === "EXPECT_MARK") return null;
  if (checkedAt >= command.scheduledAt + HOUR || checkedAt >= manifest.endAt) return "MARK_EXPIRED_BEFORE_COMMIT";
  if (command.event.type === "OBSERVE_MARK" && receipt.observation?.marks.some((mark) => {
    if (!mark.available || mark.source === "CASH") return false;
    const book = command.event.type === "OBSERVE_MARK" ? command.event.books[mark.productId]?.book : null;
    return !record(book) || !timestamp(book.sourceObservedAt) || checkedAt - book.sourceObservedAt > 5_000;
  })) return "MARK_EXPIRED_BEFORE_COMMIT";
  return null;
};

/** Calendar-based technical report only; not campaign suspension or qualification. */
export const reportP7MarkCoverage = (state: P7MarkState, manifest: Pick<P7LedgerManifest, "startAt" | "endAt">, asOf: number) => {
  if (!timestamp(asOf) || asOf < manifest.startAt || !timestamp(manifest.startAt) || !timestamp(manifest.endAt) || manifest.startAt % 86_400_000 !== 0 ||
    manifest.endAt - manifest.startAt !== 180 * 86_400_000) throw new Error("INVALID_MARK_REPORT_SCOPE");
  const end = Math.min(asOf, manifest.endAt), expectedToDate = Math.floor((end - manifest.startAt) / HOUR);
  let available = 0, unavailable = 0, unobserved = 0, pending = 0, unregistered = 0;
  const missingScheduledAt: number[] = [];
  for (let i = 0; i < expectedToDate; i++) {
    const slot = state.slots[String(manifest.startAt + i * HOUR)];
    if (slot?.observation !== null && slot?.observation !== undefined && slot.observation.asOf <= end) {
      if (slot.observation.consolidated.available) available++; else unavailable++;
    } else {
      unobserved++;
      missingScheduledAt.push(manifest.startAt + i * HOUR);
      if (slot?.phase === "requested") pending++;
      if (slot === undefined) unregistered++;
    }
  }
  const times = Object.values(state.slots).flatMap((s) => s.observation?.consolidated.available &&
    s.observation.asOf >= manifest.startAt && s.observation.asOf <= end ? [s.observation.asOf] : []).sort((a, b) => a - b);
  let previous = manifest.startAt, maxGapMs = 0;
  for (const time of times) { maxGapMs = Math.max(maxGapMs, time - previous); previous = time; }
  maxGapMs = Math.max(maxGapMs, end - previous);
  const currentHourScheduledAt = end < manifest.endAt ? manifest.startAt + expectedToDate * HOUR : null;
  const currentObservation = currentHourScheduledAt === null ? null : state.slots[String(currentHourScheduledAt)]?.observation;
  return { expectedTotal: 4320, expectedToDate, available, unavailable, unobserved, pending, unregistered,
    coverage: expectedToDate === 0 ? null : available / expectedToDate, maxGapMs, proofGapExceeded: maxGapMs > 7_200_000,
    evaluatedAt: asOf, throughAt: end, missingScheduledAt, currentHourScheduledAt,
    currentHourStatus: currentHourScheduledAt === null ? null : currentObservation && currentObservation.asOf <= end ?
      currentObservation.consolidated.available ? "AVAILABLE" : "UNAVAILABLE" : "UNOBSERVED" };
};
