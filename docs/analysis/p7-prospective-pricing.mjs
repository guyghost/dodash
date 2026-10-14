/** Synthetic local planning only: no network, order submission or ledger write. */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { planP7Pricing } = await import(require.resolve("@dodash/models"));
const { executePaperOrder } = await import(require.resolve("@dodash/paper-execution"));

export const planP7LocalTerminal = (store, productId, candleClosedAt, asOf) => {
  return planP7JournalTerminal(store.export(), productId, candleClosedAt, asOf);
};

/** Internal pure bridge used on the already-revalidated transaction journal. */
export const planP7JournalTerminal = (journal, productId, candleClosedAt, asOf) => {
  if (journal.observation !== "SYNTHETIC_LOCAL_PREPARATION") throw new Error("NOT_LOCAL_PREPARATION");
  const { state } = journal, slot = state.slots[`${productId}:${candleClosedAt}`];
  if (slot === undefined) return { kind: "NOT_READY", reason: "SLOT_MISSING" };
  if (slot.phase === "terminal") return { kind: "DONE", outcome: slot.outcome };
  if (slot.phase === "requested") return { kind: "SUSPEND", reason: "QUOTE_RESPONSE_UNOBSERVED" };
  if (slot.phase !== "quoted" || slot.intent === null) return { kind: "NOT_READY", reason: "QUOTE_NOT_PERSISTED" };
  if (!slot.quote?.eligibility.eligible) return { kind: "TERMINAL_PLAN", outcome: { kind: "QUOTE_REJECTED", reason: slot.quote?.eligibility.reason ?? "QUOTE_NOT_PERSISTED" } };
  if (slot.intent.portfolioVersion !== state.portfolios[productId].version) return { kind: "SUSPEND", reason: "PORTFOLIO_VERSION_CONFLICT" };
  if (!Number.isSafeInteger(asOf) || asOf < state.lastRecordedAt) return { kind: "SUSPEND", reason: "INVALID_CLOCK" };
  const quotes = journal.entries.filter((e) => e.command?.productId === productId &&
    e.command.candleClosedAt === candleClosedAt && e.command.event.type === "OBSERVE_QUOTE");
  if (quotes.length !== 1) throw new Error("QUOTE_FACT_CONFLICT");
  // The current sequence includes this same persisted quote; equality is permitted.
  const pricing = planP7Pricing({ productId, sourceProfileId: state.manifest.sourceProfileId,
    clockVerified: state.manifest.clockVerified, campaignStartAt: state.manifest.startAt, campaignEndAt: state.manifest.endAt,
    candleClosedAt, intentPersistedAt: slot.intent.persistedAt, previousSequence: state.lastSequences[productId] },
  quotes[0].command.event.book, slot.intent.side, slot.intent.quantity, asOf);
  if (!pricing.ok) return { kind: "TERMINAL_PLAN", outcome: { kind: "QUOTE_REJECTED", reason: pricing.reason } };
  const portfolio = state.portfolios[productId];
  // Only cash/quantity are consumed below. This adapter never exposes the broker's
  // average-price or realized-PnL fields: the ledger has no acquisition-cost projection.
  const execution = executePaperOrder({ cash: portfolio.cash, positionQuantity: portfolio.positionQuantity, averagePrice: 0 },
    { clientOrderId: `${state.manifest.campaignId}:${productId}:${candleClosedAt}`, decisionId: "synthetic-local",
      strategyIds: ["P7"], productId, side: slot.intent.side, type: "MARKET", quantity: slot.intent.quantity, limitPrice: null },
    pricing.vwap, asOf, { feeBps: 60, slippageBps: 2 });
  if (!execution.ok) return { kind: "TERMINAL_PLAN", outcome: { kind: "BROKER_REJECTED", reason: execution.error.code } };
  return { kind: "TERMINAL_PLAN", outcome: { kind: "SIMULATED_FILL", price: execution.value.trade.fill.price, fee: execution.value.trade.fill.fee },
    portfolio: { cash: execution.value.portfolio.cash, positionQuantity: execution.value.portfolio.positionQuantity },
    vwap: pricing.vwap, quantity: pricing.quantity, asOf, portfolioVersion: portfolio.version };
};
