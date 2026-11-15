import { createMachine, getNextSnapshot } from "xstate";
import { evaluateP7ExecutionBook, type P7BookEligibility } from "./p7-prospective-quote.js";

type Product = "BTC-USD" | "ETH-USD";
type Phase = "expected" | "admitted" | "intent" | "requested" | "quoted" | "terminal";
export interface P7LedgerManifest {
  readonly purpose: "LOCAL_PREPARATION";
  readonly campaignId: string;
  readonly manifestSha256: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly sourceProfileId: string;
  readonly clockVerified: boolean;
}
export interface P7LedgerPortfolio { readonly cash: number; readonly positionQuantity: number; readonly version: number }
export type P7LedgerOutcome = { readonly kind: "HOLD" | "RISK_REJECTED" | "QUOTE_REJECTED" | "BROKER_REJECTED" | "MISSED"; readonly reason?: string } |
  { readonly kind: "SIMULATED_FILL"; readonly price: number; readonly fee: number };
export interface P7LedgerCommand {
  readonly campaignId: string;
  readonly commandId: string;
  readonly productId: Product;
  readonly candleClosedAt: number;
  readonly event: { readonly type: "EXPECT" } | { readonly type: "ADMIT"; readonly evaluatedAt: number; readonly windowSha256: string } |
    { readonly type: "INTENT"; readonly side: "BUY" | "SELL"; readonly quantity: number; readonly portfolioVersion: number } |
    { readonly type: "REQUEST_QUOTE" } | { readonly type: "OBSERVE_QUOTE"; readonly book: unknown; readonly bodySha256: string } |
    { readonly type: "TERMINATE"; readonly outcome: P7LedgerOutcome };
}
export interface P7LedgerSlot {
  readonly productId: Product;
  readonly candleClosedAt: number;
  readonly phase: Phase;
  readonly revision: number;
  readonly admission: { readonly evaluatedAt: number; readonly windowSha256: string; readonly portfolioVersion: number } | null;
  readonly intent: { readonly side: "BUY" | "SELL"; readonly quantity: number; readonly portfolioVersion: number; readonly persistedAt: number } | null;
  readonly requestedAt: number | null;
  readonly quote: { readonly bodySha256: string; readonly receivedAt: number | null; readonly sequence: string | null; readonly eligibility: P7BookEligibility } | null;
  readonly outcome: P7LedgerOutcome | null;
}
export interface P7LedgerState {
  readonly manifest: P7LedgerManifest;
  readonly lastRecordedAt: number;
  readonly portfolios: Readonly<Record<Product, P7LedgerPortfolio>>;
  readonly lastSequences: Readonly<Record<Product, string | null>>;
  readonly slots: Readonly<Record<string, P7LedgerSlot>>;
}
type LedgerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };
const fail = <T>(error: string): LedgerResult<T> => ({ ok: false, error });
const safeTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const identifier = (n: unknown): n is string => typeof n === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(n);
const hash = (n: unknown): n is string => typeof n === "string" && /^[a-f0-9]{64}$/.test(n);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const record = (n: unknown): n is Record<string, unknown> => n !== null && typeof n === "object" && !Array.isArray(n);
const onlyKeys = (n: object, allowed: readonly string[]): boolean => Object.keys(n).every((key) => allowed.includes(key));
const DAY = 86_400_000;
const slotKey = (product: Product, close: number): string => `${product}:${close}`;

export const p7LedgerSlotMachine = createMachine({
  id: "p7LedgerSlot", initial: "expected",
  states: {
    expected: { on: { ADMIT: "admitted", TERMINATE: "terminal" } },
    admitted: { on: { INTENT: "intent", TERMINATE: "terminal" } },
    intent: { on: { REQUEST_QUOTE: "requested" } },
    requested: { on: { OBSERVE_QUOTE: "quoted", TERMINATE: "terminal" } },
    quoted: { on: { TERMINATE: "terminal" } }, terminal: { type: "final" },
  },
});

export const initializeP7Ledger = (manifest: P7LedgerManifest, recordedAt: number): LedgerResult<P7LedgerState> => {
  if (!record(manifest) || manifest.purpose !== "LOCAL_PREPARATION" || !identifier(manifest.campaignId) || !identifier(manifest.sourceProfileId) ||
    !onlyKeys(manifest, ["purpose", "campaignId", "manifestSha256", "startAt", "endAt", "sourceProfileId", "clockVerified"]) ||
    !hash(manifest.manifestSha256) || typeof manifest.clockVerified !== "boolean" ||
    ![recordedAt, manifest.startAt, manifest.endAt].every(safeTime) || recordedAt >= manifest.startAt ||
    manifest.startAt % DAY !== 0 || manifest.endAt - manifest.startAt !== 180 * DAY) return fail("INVALID_MANIFEST");
  return { ok: true, value: { manifest: { ...manifest }, lastRecordedAt: recordedAt, slots: {},
    portfolios: { "BTC-USD": { cash: 10_000, positionQuantity: 0, version: 0 }, "ETH-USD": { cash: 10_000, positionQuantity: 0, version: 0 } },
    lastSequences: { "BTC-USD": null, "ETH-USD": null } } };
};

export const applyP7LedgerCommand = (state: P7LedgerState, command: P7LedgerCommand, recordedAt: number): LedgerResult<{
  readonly state: P7LedgerState;
  readonly receipt: { readonly slotKey: string; readonly phase: Phase; readonly revision: number; readonly portfolio: P7LedgerPortfolio };
}> => {
  if (!record(command) || !identifier(command.commandId) || command.campaignId !== state.manifest.campaignId ||
    !onlyKeys(command, ["campaignId", "commandId", "productId", "candleClosedAt", "event"]) ||
    !["BTC-USD", "ETH-USD"].includes(command.productId) || !safeTime(command.candleClosedAt) || command.candleClosedAt % DAY !== 0 ||
    command.candleClosedAt < state.manifest.startAt || command.candleClosedAt >= state.manifest.endAt || !record(command.event) ||
    !safeTime(recordedAt) || recordedAt < state.lastRecordedAt) return fail("INVALID_COMMAND");
  const key = slotKey(command.productId, command.candleClosedAt), event = command.event;
  const eventKeys: Record<P7LedgerCommand["event"]["type"], readonly string[]> = {
    EXPECT: ["type"], ADMIT: ["type", "evaluatedAt", "windowSha256"], INTENT: ["type", "side", "quantity", "portfolioVersion"],
    REQUEST_QUOTE: ["type"], OBSERVE_QUOTE: ["type", "book", "bodySha256"], TERMINATE: ["type", "outcome"],
  };
  if (!Object.hasOwn(eventKeys, event.type) || !onlyKeys(event, eventKeys[event.type])) return fail("INVALID_COMMAND");
  const current = state.slots[key];
  const portfolio = state.portfolios[command.productId];
  const inWindow = recordedAt >= command.candleClosedAt && recordedAt <= command.candleClosedAt + 7_200_000 && recordedAt < state.manifest.endAt;
  if (event.type === "EXPECT") {
    if (current !== undefined) return fail("INVALID_PHASE");
    const slot: P7LedgerSlot = { productId: command.productId, candleClosedAt: command.candleClosedAt, phase: "expected", revision: 1,
      admission: null, intent: null, requestedAt: null, quote: null, outcome: null };
    return { ok: true, value: { state: { ...state, lastRecordedAt: recordedAt, slots: { ...state.slots, [key]: slot } },
      receipt: { slotKey: key, phase: slot.phase, revision: slot.revision, portfolio } } };
  }
  if (current === undefined || current.phase === "terminal") return fail("INVALID_PHASE");
  let next: P7LedgerSlot = { ...current, revision: current.revision + 1 };
  let nextPortfolio = portfolio;
  let sequence = state.lastSequences[command.productId];
  switch (event.type) {
    case "ADMIT":
      if (current.phase !== "expected") return fail("INVALID_PHASE");
      if (!inWindow || !safeTime(event.evaluatedAt) || event.evaluatedAt < command.candleClosedAt || event.evaluatedAt > recordedAt || !hash(event.windowSha256)) return fail("INVALID_ADMISSION");
      next = { ...next, admission: { evaluatedAt: event.evaluatedAt, windowSha256: event.windowSha256, portfolioVersion: portfolio.version } };
      break;
    case "INTENT":
      if (current.phase !== "admitted") return fail("INVALID_PHASE");
      if (!inWindow || !positive(event.quantity) || !["BUY", "SELL"].includes(event.side)) return fail("INVALID_INTENT");
      if (event.portfolioVersion !== portfolio.version || current.admission?.portfolioVersion !== portfolio.version) return fail("PORTFOLIO_VERSION_CONFLICT");
      if (Object.values(state.slots).some((s) => s.productId === command.productId && s.intent !== null && s.phase !== "terminal")) return fail("PRODUCT_BUSY");
      next = { ...next, intent: { side: event.side, quantity: event.quantity, portfolioVersion: event.portfolioVersion, persistedAt: recordedAt } };
      break;
    case "REQUEST_QUOTE":
      if (current.phase !== "intent") return fail("INVALID_PHASE");
      if (!inWindow) return fail("WINDOW_EXPIRED");
      next = { ...next, requestedAt: recordedAt };
      break;
    case "OBSERVE_QUOTE": {
      if (current.phase !== "requested" || current.intent === null || current.requestedAt === null) return fail("INVALID_PHASE");
      if (!hash(event.bodySha256)) return fail("INVALID_QUOTE_HASH");
      const book = record(event.book) ? event.book : null;
      if (book !== null && !onlyKeys(book, ["productId", "sourceProfileId", "cacheStatus", "sequence", "requestedAt", "receivedAt", "sourceObservedAt", "bids", "asks"])) return fail("INVALID_QUOTE_FIELDS");
      if (book !== null && [book.bids, book.asks].some((side) => Array.isArray(side) && side.some((level: unknown) => record(level) && !onlyKeys(level, ["price", "quantity"])))) return fail("INVALID_QUOTE_FIELDS");
      let eligibility = evaluateP7ExecutionBook({ productId: command.productId, sourceProfileId: state.manifest.sourceProfileId,
        clockVerified: state.manifest.clockVerified, campaignStartAt: state.manifest.startAt, campaignEndAt: state.manifest.endAt,
        candleClosedAt: command.candleClosedAt, intentPersistedAt: current.intent.persistedAt, previousSequence: sequence }, book);
      if (book === null || book.requestedAt !== current.requestedAt || !safeTime(book.receivedAt) || book.receivedAt > recordedAt) eligibility = { eligible: false, reason: "INVALID_TIMELINE" };
      if (eligibility.eligible) sequence = book?.sequence as string;
      next = { ...next, quote: { bodySha256: event.bodySha256, receivedAt: safeTime(book?.receivedAt) ? book.receivedAt : null,
        sequence: typeof book?.sequence === "string" ? book.sequence : null, eligibility } };
      break;
    }
    case "TERMINATE": {
      const outcome = event.outcome;
      if (!record(outcome) || typeof outcome.kind !== "string") return fail("INVALID_OUTCOME");
      const kind = outcome.kind;
      if (!onlyKeys(outcome, kind === "SIMULATED_FILL" ? ["kind", "price", "fee"] : ["kind", "reason"]) ||
        ("reason" in outcome && (typeof outcome.reason !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(outcome.reason)))) return fail("INVALID_OUTCOME");
      if (kind === "MISSED") {
        if (current.phase !== "expected" || recordedAt <= command.candleClosedAt + 7_200_000) return fail("INVALID_PHASE");
      } else if (kind === "HOLD" || kind === "RISK_REJECTED") {
        if (current.phase !== "admitted" || !inWindow) return fail("INVALID_PHASE");
      } else if (kind === "QUOTE_REJECTED") {
        if (current.phase !== "quoted" && current.phase !== "requested") return fail("INVALID_PHASE");
        if (current.phase === "requested" && outcome.reason !== "QUOTE_RESPONSE_UNOBSERVED") return fail("PROOF_GAP_REASON_REQUIRED");
      } else if (kind === "BROKER_REJECTED" || kind === "SIMULATED_FILL") {
        if (current.phase !== "quoted" || !current.quote?.eligibility.eligible || current.intent === null) return fail("INVALID_PHASE");
        if (!inWindow) return fail("WINDOW_EXPIRED");
      } else return fail("INVALID_OUTCOME");
      const version = current.intent?.portfolioVersion ?? current.admission?.portfolioVersion ?? portfolio.version;
      if (version !== portfolio.version) return fail("PORTFOLIO_VERSION_CONFLICT");
      if (kind === "SIMULATED_FILL" && outcome.kind === "SIMULATED_FILL" && current.intent !== null) {
        if (!positive(outcome.price) || typeof outcome.fee !== "number" || !Number.isFinite(outcome.fee) || outcome.fee < 0) return fail("INVALID_FILL");
        const notional = outcome.price * current.intent.quantity, expectedFee = notional * 0.006;
        if (!Number.isFinite(notional) || Math.abs(outcome.fee - expectedFee) > Math.max(1, expectedFee) * Number.EPSILON * 16) return fail("INVALID_FILL_FEE");
        const cash = portfolio.cash + (current.intent.side === "BUY" ? -notional - outcome.fee : notional - outcome.fee);
        const quantity = portfolio.positionQuantity + (current.intent.side === "BUY" ? current.intent.quantity : -current.intent.quantity);
        const cashTolerance = Math.max(1, Math.abs(portfolio.cash)) * Number.EPSILON * 16;
        const quantityTolerance = Math.max(1, Math.abs(portfolio.positionQuantity)) * Number.EPSILON * 16;
        if (!Number.isFinite(cash) || cash < -cashTolerance || !Number.isFinite(quantity) || quantity < -quantityTolerance) return fail("PORTFOLIO_INVARIANT_FAILED");
        nextPortfolio = { cash: Math.abs(cash) <= cashTolerance ? 0 : cash, positionQuantity: Math.abs(quantity) <= quantityTolerance ? 0 : quantity, version: portfolio.version };
      }
      nextPortfolio = { ...nextPortfolio, version: portfolio.version + 1 };
      next = { ...next, outcome: { ...outcome } };
      break;
    }
    default: return fail("INVALID_COMMAND");
  }
  const snapshot = p7LedgerSlotMachine.resolveState({ value: current.phase, context: {} });
  const phase = getNextSnapshot(p7LedgerSlotMachine, snapshot, { type: event.type }).value as Phase;
  if (phase === current.phase) return fail("INVALID_PHASE");
  next = { ...next, phase };
  const after: P7LedgerState = { ...state, lastRecordedAt: recordedAt, slots: { ...state.slots, [key]: next },
    portfolios: { ...state.portfolios, [command.productId]: nextPortfolio }, lastSequences: { ...state.lastSequences, [command.productId]: sequence } };
  return { ok: true, value: { state: after, receipt: { slotKey: key, phase, revision: next.revision, portfolio: nextPortfolio } } };
};

export const planP7LedgerRecovery = (state: P7LedgerState, product: Product, close: number, now: number): { readonly action: string; readonly reason?: string } => {
  const slot = state.slots[slotKey(product, close)];
  if (slot === undefined) return { action: "EXPECT_SLOT" };
  if (slot.phase === "terminal") return { action: "DONE" };
  if (slot.phase === "requested") return { action: "SUSPEND", reason: "QUOTE_RESPONSE_UNOBSERVED" };
  if (!safeTime(now) || now < state.lastRecordedAt) return { action: "SUSPEND", reason: "INVALID_CLOCK" };
  if (slot.phase === "quoted" && (now > close + 7_200_000 || now >= state.manifest.endAt)) return { action: "REJECT_EXPIRED_QUOTE" };
  if (slot.phase === "quoted" && !slot.quote?.eligibility.eligible) return { action: "REJECT_INVALID_QUOTE" };
  return { action: slot.phase === "quoted" ? "RESUME_SAME_QUOTE" : "RESUME_CHECKPOINT" };
};
