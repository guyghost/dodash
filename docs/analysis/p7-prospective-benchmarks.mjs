/** Offline synthetic replay only. No benchmark fills or marks written to the store. */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/backtest/package.json", import.meta.url));
const { sizeP7BenchmarkBuy, planP7Pricing, valueP7Liquidation, consolidateP7Marks, reportP7MarkCoverage, emptyP7MarkState } = await import(require.resolve("@dodash/models"));
const { executePaperOrder } = await import(require.resolve("@dodash/paper-execution"));
const PRODUCTS = ["BTC-USD", "ETH-USD"];

/** Broker agreement check on a model-derived, synthetic initial purchase. */
export const verifyP7IndependentBenchmarkFill = (leg, productId) => {
  if (leg.phase !== "initialized") return;
  const execution = executePaperOrder({ cash: 10_000, positionQuantity: 0, averagePrice: 0 }, {
    clientOrderId: `synthetic-bh-${productId}`, decisionId: "synthetic-bh", strategyIds: ["BUY_AND_HOLD"], productId,
    side: "BUY", type: "MARKET", quantity: leg.quantity, limitPrice: null,
  }, leg.vwap, leg.fill.executedAt, { feeBps: 60, slippageBps: 2 });
  if (!execution.ok || execution.value.trade.fill.price !== leg.fill.price || execution.value.trade.fill.fee !== leg.fill.fee ||
    execution.value.portfolio.cash !== leg.portfolio.cash || execution.value.portfolio.positionQuantity !== leg.portfolio.positionQuantity) throw new Error("BENCHMARK_BROKER_MISMATCH");
};

export const projectP7LocalBenchmarks = (store, asOf) => {
  const journal = store.export(), { state, benchmarkProfile, markState } = journal, manifest = state.manifest;
  if (journal.observation !== "SYNTHETIC_LOCAL_PREPARATION" || !Number.isSafeInteger(asOf) || asOf < Math.max(manifest.startAt, state.lastRecordedAt)) throw new Error("INVALID_BENCHMARK_REPLAY_SCOPE");
  const products = Object.fromEntries(PRODUCTS.map((productId) => {
    const failed = (reason, status = "NOT_INITIALIZED") => [productId, { status, reason }];
    if (benchmarkProfile === null) return failed("PROFILE_NOT_REGISTERED");
    if (journal.benchmarkEntries.active) {
      const leg = journal.benchmarkEntries.products[productId];
      if (leg?.phase === "initialized") return [productId, { status: "INITIALIZED", quantity: leg.quantity,
        entrySequence: journal.entries.find((e) => e.command?.commandId === leg.quoteCommandId)?.sequence,
        bodySha256: leg.bodySha256, fill: leg.fill, portfolio: leg.portfolio }];
      return failed(leg?.reason ?? (leg?.phase === "requested" ? "RESPONSE_UNOBSERVED" : "INITIAL_BOOK_UNOBSERVED"),
        leg?.phase === "failed" || asOf > manifest.startAt + 7_200_000 ? "NOT_INITIALIZED" : "PENDING");
    }
    const entry = journal.entries.find((e) => e.command?.productId === productId && e.command.candleClosedAt === manifest.startAt && e.command.event?.type === "OBSERVE_QUOTE");
    if (entry === undefined) return failed("INITIAL_BOOK_UNOBSERVED", asOf <= manifest.startAt + 7_200_000 ? "PENDING" : "NOT_INITIALIZED");
    const slot = state.slots[`${productId}:${manifest.startAt}`];
    if (!slot?.quote?.eligibility.eligible || slot.intent === null) return failed(slot?.quote?.eligibility.reason ?? "INITIAL_BOOK_UNVERIFIABLE");
    const book = entry.command.event.book, sizing = sizeP7BenchmarkBuy(book, benchmarkProfile.quantityDecimals[productId]);
    if (!sizing.ok) return failed(sizing.reason);
    const pricing = planP7Pricing({ productId, sourceProfileId: manifest.sourceProfileId, clockVerified: manifest.clockVerified,
      campaignStartAt: manifest.startAt, campaignEndAt: manifest.endAt, candleClosedAt: manifest.startAt,
      intentPersistedAt: slot.intent.persistedAt, previousSequence: null }, book, "BUY", sizing.quantity, entry.recordedAt);
    if (!pricing.ok) return failed(pricing.reason);
    const execution = executePaperOrder({ cash: 10_000, positionQuantity: 0, averagePrice: 0 }, {
      clientOrderId: `synthetic-bh-${productId}`, decisionId: "synthetic-bh", strategyIds: ["BUY_AND_HOLD"], productId,
      side: "BUY", type: "MARKET", quantity: sizing.quantity, limitPrice: null,
    }, pricing.vwap, entry.recordedAt, { feeBps: 60, slippageBps: 2 });
    if (!execution.ok) return failed(execution.error.code);
    return [productId, { status: "INITIALIZED", quantity: sizing.quantity, entrySequence: entry.sequence,
      bodySha256: entry.command.event.bodySha256, fill: execution.value.trade.fill,
      portfolio: { cash: execution.value.portfolio.cash, positionQuantity: execution.value.portfolio.positionQuantity } }];
  }));
  const initializationComplete = PRODUCTS.every((p) => products[p].status === "INITIALIZED");
  const observations = [];
  const projected = emptyP7MarkState();
  const previousSequences = { "BTC-USD": null, "ETH-USD": null };
  for (const entry of journal.entries) {
    if (entry.schemaVersion !== 3) continue;
    const command = entry.command;
    if (command.event.type !== "OBSERVE_MARK") {
      const original = markState.slots[String(command.scheduledAt)];
      projected.slots[String(command.scheduledAt)] = { ...original, phase: command.event.type === "EXPECT_MARK" ? "expected" : "requested", observation: null };
      continue;
    }
    const slot = markState.slots[String(command.scheduledAt)];
    const marks = PRODUCTS.map((productId) => {
      const unavailable = (reason) => ({ productId, asOf: entry.recordedAt, available: false, equity: null, reason });
      if (!initializationComplete || entry.recordedAt < products[productId].fill.executedAt) return unavailable("BENCHMARK_NOT_INITIALIZED");
      const book = command.event.books[productId]?.book;
      const mark = valueP7Liquidation({ productId, sourceProfileId: manifest.sourceProfileId, clockVerified: manifest.clockVerified,
        campaignStartAt: manifest.startAt, campaignEndAt: manifest.endAt, previousSequence: previousSequences[productId] }, book, products[productId].portfolio, entry.recordedAt);
      if (mark.available && mark.source !== "CASH") {
        if (book.requestedAt !== slot.requestedAt) return unavailable("REQUEST_CHECKPOINT_MISMATCH");
        previousSequences[productId] = book.sequence;
      }
      return mark;
    });
    const observation = { asOf: entry.recordedAt, marks, consolidated: consolidateP7Marks(marks) };
    projected.slots[String(command.scheduledAt)] = { ...slot, observation };
    observations.push({ scheduledAt: command.scheduledAt, ...observation });
  }
  return { observation: "SYNTHETIC_LOCAL_PREPARATION", costAssumptions: { simulated: true, feeBps: 60, slippageBps: 2 }, profile: benchmarkProfile,
    cash: { source: "ANALYTIC_CASH_REFERENCE", equity: 20_000, rate: 0 },
    buyAndHold: { entryMode: journal.benchmarkEntries.active ? "INDEPENDENT_DURABLE" : "LEGACY_ARCHIVE_REPLAY", initializationComplete, products, observations },
    coverage: { p7: reportP7MarkCoverage(markState, manifest, asOf), buyAndHold: reportP7MarkCoverage(projected, manifest, asOf) } };
};
