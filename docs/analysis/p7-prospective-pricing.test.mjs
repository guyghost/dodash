import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { P7LocalLedgerStore } from "./p7-prospective-ledger-store.mjs";
import { planP7LocalTerminal } from "./p7-prospective-pricing.mjs";
const start = Date.UTC(2026, 9, 16), at = start + 1_000;
const manifest = { purpose: "LOCAL_PREPARATION", campaignId: "pricing-fixture", manifestSha256: "a".repeat(64),
  startAt: start, endAt: start + 180 * 86_400_000, sourceProfileId: "fixture", clockVerified: true };
const setup = (quantity = 2, quoteOverride = {}, path = ":memory:") => {
  let now = start - 1;
  const store = new P7LocalLedgerStore(path, manifest, { now: () => now });
  const command = (event) => ({ campaignId: manifest.campaignId, commandId: event.type, productId: "BTC-USD", candleClosedAt: start, event });
  now = at;
  for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: start + 1, windowSha256: "b".repeat(64) },
    { type: "INTENT", side: "BUY", quantity, portfolioVersion: 0 }, { type: "REQUEST_QUOTE" },
    { type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: {
      productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "1",
      requestedAt: at, receivedAt: at, sourceObservedAt: at,
      bids: [{ price: 99, quantity: 100 }], asks: [{ price: 101, quantity: 1 }, { price: 102, quantity: 99 }],
      ...quoteOverride,
    } }]) store.apply(command(event));
  return { store, command, setNow: (value) => { now = value; } };
};
test("real broker applies slippage and fee once to persisted VWAP, ledger commits the same balances", () => {
  const { store, command } = setup();
  try {
    const before = store.export();
    const plan = planP7LocalTerminal(store, "BTC-USD", start, at);
    assert.equal(plan.kind, "TERMINAL_PLAN");
    assert.equal(plan.outcome.kind, "SIMULATED_FILL");
    assert.equal(plan.outcome.price, 101.5 * 1.0002);
    assert.equal(plan.outcome.fee, 101.5 * 1.0002 * 2 * 0.006);
    assert.deepEqual(store.export(), before);
    const cmd = command({ type: "TERMINATE", outcome: plan.outcome });
    const receipt = store.apply(cmd);
    assert.equal(receipt.portfolio.cash, plan.portfolio.cash);
    assert.equal(receipt.portfolio.positionQuantity, plan.portfolio.positionQuantity);
    assert.deepEqual(store.apply(cmd), receipt);
    assert.equal(planP7LocalTerminal(store, "BTC-USD", start, at + 100_000).kind, "DONE");
  } finally { store.close(); }
});
test("fixed quantity exceeding cash is rejected, never resized", () => {
  const { store } = setup(100);
  try {
    const plan = planP7LocalTerminal(store, "BTC-USD", start, at);
    assert.deepEqual(plan.outcome, { kind: "BROKER_REJECTED", reason: "INSUFFICIENT_CASH" });
    assert.equal(store.export().state.portfolios["BTC-USD"].cash, 10_000);
  } finally { store.close(); }
});
test("depth shortage and stale use refuse without a replacement quote", () => {
  const { store } = setup(101);
  try {
    assert.deepEqual(planP7LocalTerminal(store, "BTC-USD", start, at).outcome, { kind: "QUOTE_REJECTED", reason: "INSUFFICIENT_DEPTH" });
    assert.deepEqual(planP7LocalTerminal(store, "BTC-USD", start, at + 5_001).outcome, { kind: "QUOTE_REJECTED", reason: "STALE_AT_USE" });
    assert.equal(store.export().entries.length, 6);
  } finally { store.close(); }
});
test("an ineligible persisted quote cannot be promoted later by re-evaluation", () => {
  const { store } = setup(2, { receivedAt: at + 1 }); // Future at persistence, later no longer future.
  try {
    assert.equal(store.export().state.slots[`BTC-USD:${start}`].quote.eligibility.eligible, false);
    assert.deepEqual(planP7LocalTerminal(store, "BTC-USD", start, at + 2).outcome, { kind: "QUOTE_REJECTED", reason: "INVALID_TIMELINE" });
  } finally { store.close(); }
});
test("sell pricing reuses the persisted bids and exposes no invented realized PnL", () => {
  const { store, command, setNow } = setup();
  try {
    store.apply(command({ type: "TERMINATE", outcome: planP7LocalTerminal(store, "BTC-USD", start, at).outcome }));
    const nextClose = start + 86_400_000;
    const nextAt = nextClose + 1_000;
    setNow(nextAt);
    for (const event of [{ type: "EXPECT" }, { type: "ADMIT", evaluatedAt: nextClose + 1, windowSha256: "b".repeat(64) },
      { type: "INTENT", side: "SELL", quantity: 1, portfolioVersion: 1 }, { type: "REQUEST_QUOTE" },
      { type: "OBSERVE_QUOTE", bodySha256: "d".repeat(64), book: { productId: "BTC-USD", sourceProfileId: "fixture", cacheStatus: "UNCACHED", sequence: "2",
        requestedAt: nextAt, receivedAt: nextAt, sourceObservedAt: nextAt, bids: [{ price: 99, quantity: 2 }], asks: [{ price: 101, quantity: 2 }] } }])
      store.apply({ ...command(event), commandId: `sell-${event.type}`, candleClosedAt: nextClose });
    const plan = planP7LocalTerminal(store, "BTC-USD", nextClose, nextAt);
    assert.equal(plan.outcome.price, 99 * 0.9998);
    assert.equal(plan.outcome.fee, 99 * 0.9998 * 0.006);
    assert.equal(Object.hasOwn(plan, "realizedPnl"), false);
    const receipt = store.apply({ ...command({ type: "TERMINATE", outcome: plan.outcome }), commandId: "sell-terminal", candleClosedAt: nextClose });
    assert.deepEqual({ cash: receipt.portfolio.cash, positionQuantity: receipt.portfolio.positionQuantity }, plan.portfolio);
  } finally { store.close(); }
});
test("reopening a committed priced fill returns DONE without repricing or another debit", () => {
  const preferred = resolve(tmpdir(), "opencode");
  const path = resolve(mkdtempSync(resolve(existsSync(preferred) ? preferred : tmpdir(), "p7-pricing-")), "ledger.sqlite");
  const { store, command } = setup(2, {}, path);
  const plan = planP7LocalTerminal(store, "BTC-USD", start, at);
  const cmd = command({ type: "TERMINATE", outcome: plan.outcome });
  const receipt = store.apply(cmd); store.close();
  const reopened = new P7LocalLedgerStore(path, manifest, { now: () => manifest.endAt + 1 });
  try {
    assert.equal(planP7LocalTerminal(reopened, "BTC-USD", start, manifest.endAt + 1).kind, "DONE");
    assert.deepEqual(reopened.apply(cmd), receipt);
    assert.equal(reopened.export().state.portfolios["BTC-USD"].cash, plan.portfolio.cash);
  } finally { reopened.close(); }
});
