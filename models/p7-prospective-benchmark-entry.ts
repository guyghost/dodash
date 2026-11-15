import { setup, getNextSnapshot } from "xstate";
import type { P7LedgerState } from "./p7-prospective-ledger.js";
import type { P7LocalCampaignState } from "./p7-prospective-campaign-safety.js";
import { evaluateP7ExecutionBook, type P7BookEligibility } from "./p7-prospective-quote.js";
import { planP7Pricing } from "./p7-prospective-pricing.js";
import { sizeP7BenchmarkBuy, type P7BenchmarkProfile } from "./p7-prospective-benchmarks.js";
type Product = "BTC-USD" | "ETH-USD";
type Phase = "expected" | "requested" | "rejected" | "quoted" | "initialized" | "failed";
export interface P7BenchmarkLeg {
  readonly phase: Phase; readonly attempt: number; readonly requestedAt: number | null;
  readonly profileSha256: string | null; readonly book: unknown; readonly bodySha256: string | null;
  readonly quoteCommandId: string | null; readonly eligibility: P7BookEligibility | null; readonly reason: string | null;
  readonly quantity: number | null; readonly vwap: number | null;
  readonly fill: { readonly price: number; readonly quantity: number; readonly fee: number; readonly executedAt: number } | null;
  readonly portfolio: { readonly cash: number; readonly positionQuantity: number } | null;
}
export interface P7BenchmarkEntries {
  readonly active: boolean; readonly lastRecordedAt: number; readonly products: Readonly<Record<Product, P7BenchmarkLeg | null>>;
}
export const emptyP7BenchmarkEntries = (): P7BenchmarkEntries => ({ active: false, lastRecordedAt: 0, products: { "BTC-USD": null, "ETH-USD": null } });
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, allowed: readonly string[]): boolean => Object.keys(v).length === allowed.length && Object.keys(v).every((k) => allowed.includes(k));
export const p7BenchmarkEntryMachine = setup({ types: { context: {} as Record<string, never>,
  events: {} as { readonly type: "REQUEST" | "ACCEPT" | "REJECT" | "RESOLVE" | "FAIL" } } }).createMachine({
  id: "p7BenchmarkEntry", context: {}, initial: "expected", states: {
    expected: { on: { REQUEST: "requested", FAIL: "failed" } },
    requested: { on: { ACCEPT: "quoted", REJECT: "rejected" } },
    rejected: { on: { REQUEST: "requested", FAIL: "failed" } },
    quoted: { on: { RESOLVE: "initialized", FAIL: "failed" } }, initialized: { type: "final" }, failed: { type: "final" },
  },
});

export const applyP7BenchmarkEntry = (state: P7BenchmarkEntries, ledger: P7LedgerState, profile: P7BenchmarkProfile | null,
  campaignPhase: P7LocalCampaignState["phase"], input: unknown, recordedAt: number, initialMarketPublished = false):
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly value: { readonly state: P7BenchmarkEntries; readonly receipt: P7BenchmarkLeg } } => {
  const fail = (error: string): { readonly ok: false; readonly error: string } => ({ ok: false, error });
  if (!record(input) || !keys(input, ["campaignId", "commandId", "productId", "event"]) || input.campaignId !== ledger.manifest.campaignId ||
    typeof input.commandId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.commandId) ||
    (input.productId !== "BTC-USD" && input.productId !== "ETH-USD") || !record(input.event) ||
    !time(recordedAt) || recordedAt < Math.max(state.lastRecordedAt, ledger.lastRecordedAt)) return fail("INVALID_BENCHMARK_ENTRY_COMMAND");
  const product = input.productId, event = input.event, type = event.type;
  if (!["EXPECT_BENCHMARK", "REQUEST_BENCHMARK", "OBSERVE_BENCHMARK_BOOK", "RESOLVE_BENCHMARK", "EXPIRE_BENCHMARK"].includes(String(type)) ||
    !keys(event, type === "OBSERVE_BENCHMARK_BOOK" ? ["type", "book", "bodySha256"] : ["type"])) return fail("INVALID_BENCHMARK_ENTRY_COMMAND");
  const current = state.products[product];
  let leg: P7BenchmarkLeg, transition: "REQUEST" | "ACCEPT" | "REJECT" | "RESOLVE" | "FAIL" = "REQUEST";
  const inWindow = recordedAt >= ledger.manifest.startAt && recordedAt <= ledger.manifest.startAt + 7_200_000 && recordedAt < ledger.manifest.endAt;
  if (type === "EXPECT_BENCHMARK") {
    if (!state.active && initialMarketPublished) return fail("BENCHMARK_MODE_ALREADY_OBSERVED");
    if (current !== null) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
    leg = { phase: "expected", attempt: 0, requestedAt: null, profileSha256: null, book: null, bodySha256: null,
      quoteCommandId: null, eligibility: null, reason: null, quantity: null, vwap: null, fill: null, portfolio: null };
  } else {
    if (current === null || ["initialized", "failed"].includes(current.phase)) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
    leg = current;
    if (type === "REQUEST_BENCHMARK") {
      if (!["expected", "rejected"].includes(current.phase)) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
      if (!inWindow || profile === null || profile.sourceProfileId !== ledger.manifest.sourceProfileId || campaignPhase !== "localObserving") return fail("BENCHMARK_ENTRY_BLOCKED");
      leg = { ...current, attempt: current.attempt + 1, requestedAt: recordedAt, profileSha256: profile.profileSha256,
        book: null, bodySha256: null, quoteCommandId: null, eligibility: null, reason: null };
    } else if (type === "OBSERVE_BENCHMARK_BOOK") {
      if (current.phase !== "requested" || current.requestedAt === null) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
      if (typeof event.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(event.bodySha256)) return fail("INVALID_BENCHMARK_BOOK_HASH");
      const book = event.book;
      if (record(book) && (Object.keys(book).some((k) => !["productId", "sourceProfileId", "cacheStatus", "sequence", "requestedAt", "receivedAt", "sourceObservedAt", "bids", "asks"].includes(k)) ||
        [book.bids, book.asks].some((side) => Array.isArray(side) && side.some((level: unknown) => record(level) && !keys(level, ["price", "quantity"]))))) return fail("INVALID_BENCHMARK_BOOK_FIELDS");
      let eligibility = evaluateP7ExecutionBook({ productId: product, sourceProfileId: ledger.manifest.sourceProfileId, clockVerified: ledger.manifest.clockVerified,
        campaignStartAt: ledger.manifest.startAt, campaignEndAt: ledger.manifest.endAt, candleClosedAt: ledger.manifest.startAt,
        intentPersistedAt: current.requestedAt, previousSequence: null }, book);
      if (!record(book) || book.requestedAt !== current.requestedAt || !time(book.receivedAt) || book.receivedAt > recordedAt || !inWindow) eligibility = { eligible: false, reason: "INVALID_TIMELINE" };
      if (eligibility.eligible && (!record(book) || !time(book.sourceObservedAt) || recordedAt - book.sourceObservedAt > 5_000)) eligibility = { eligible: false, reason: "SOURCE_TIME_INVALID" };
      leg = { ...current, book, bodySha256: event.bodySha256, quoteCommandId: input.commandId, eligibility, reason: eligibility.eligible ? null : eligibility.reason };
      transition = eligibility.eligible ? "ACCEPT" : "REJECT";
    } else if (type === "RESOLVE_BENCHMARK") {
      if (current.phase !== "quoted" || current.requestedAt === null) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
      let reason: string | null = null;
      if (!inWindow) reason = "INITIAL_WINDOW_EXPIRED";
      else if (campaignPhase !== "localObserving") reason = "CAMPAIGN_SAFETY_BLOCKED";
      else if (profile === null || profile.profileSha256 !== current.profileSha256) reason = "PROFILE_UNVERIFIABLE";
      const sizing = reason === null && profile !== null ? sizeP7BenchmarkBuy(current.book, profile.quantityDecimals[product]) : null;
      if (sizing !== null && !sizing.ok) reason = sizing.reason;
      const pricing = reason === null && sizing?.ok ? planP7Pricing({ productId: product, sourceProfileId: ledger.manifest.sourceProfileId,
        clockVerified: ledger.manifest.clockVerified, campaignStartAt: ledger.manifest.startAt, campaignEndAt: ledger.manifest.endAt,
        candleClosedAt: ledger.manifest.startAt, intentPersistedAt: current.requestedAt, previousSequence: null }, current.book, "BUY", sizing.quantity, recordedAt) : null;
      if (pricing !== null && !pricing.ok) reason = pricing.reason;
      if (reason !== null || !sizing?.ok || !pricing?.ok) { leg = { ...current, reason: reason ?? "NUMERIC_RANGE" }; transition = "FAIL"; }
      else {
        const price = pricing.vwap * 1.0002, notional = price * sizing.quantity, fee = notional * 0.006, cash = 10_000 - (notional + fee);
        if (![price, notional, fee, cash].every(Number.isFinite) || cash < 0 || fee <= 0) { leg = { ...current, reason: "NUMERIC_RANGE" }; transition = "FAIL"; }
        else { leg = { ...current, quantity: sizing.quantity, vwap: pricing.vwap, fill: { price, quantity: sizing.quantity, fee, executedAt: recordedAt },
          portfolio: { cash: cash <= 10_000 * Number.EPSILON * 16 ? 0 : cash, positionQuantity: sizing.quantity }, reason: null }; transition = "RESOLVE"; }
      }
    } else {
      if (current.phase === "requested") return fail("BENCHMARK_RESPONSE_UNOBSERVED");
      if (recordedAt <= ledger.manifest.startAt + 7_200_000) return fail("BENCHMARK_WINDOW_NOT_ENDED");
      leg = { ...current, reason: "INITIAL_WINDOW_EXPIRED" }; transition = "FAIL";
    }
    const snapshot = p7BenchmarkEntryMachine.resolveState({ value: current.phase, context: {} });
    const phase = getNextSnapshot(p7BenchmarkEntryMachine, snapshot, { type: transition }).value as Phase;
    if (phase === current.phase) return fail("INVALID_BENCHMARK_ENTRY_PHASE");
    leg = { ...leg, phase };
  }
  return { ok: true, value: { state: { active: true, lastRecordedAt: recordedAt, products: { ...state.products, [product]: leg } }, receipt: leg } };
};

export const recoverP7BenchmarkEntry = (state: P7BenchmarkEntries, product: Product) => ({
  action: state.products[product]?.phase === "requested" ? "SUSPEND" : ["initialized", "failed"].includes(state.products[product]?.phase ?? "") ? "DONE" : "RESUME_CHECKPOINT",
});
