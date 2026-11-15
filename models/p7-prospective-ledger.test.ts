import { describe, expect, it } from "vitest";
import { applyP7LedgerCommand, initializeP7Ledger, planP7LedgerRecovery, type P7LedgerCommand } from "./p7-prospective-ledger.js";

const close = Date.UTC(2026, 9, 16);
const manifest = { purpose: "LOCAL_PREPARATION" as const, campaignId: "fixture-p7", manifestSha256: "a".repeat(64),
  startAt: close, endAt: close + 180 * 86_400_000, sourceProfileId: "fixture-spot", clockVerified: true };
const command = (event: P7LedgerCommand["event"], id: string = event.type, productId: "BTC-USD" | "ETH-USD" = "BTC-USD"): P7LedgerCommand => ({
  campaignId: manifest.campaignId, commandId: id, productId, candleClosedAt: close, event,
});
const fresh = () => {
  const result = initializeP7Ledger(manifest, close - 1);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const step = (state: ReturnType<typeof fresh>, event: P7LedgerCommand["event"], at = close + 60_000) => {
  const result = applyP7LedgerCommand(state, command(event), at);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
};
const intent = () => step(step(step(fresh(), { type: "EXPECT" }), { type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) }),
  { type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 });
const quoted = () => step(step(intent(), { type: "REQUEST_QUOTE" }, close + 60_001), {
  type: "OBSERVE_QUOTE", bodySha256: "c".repeat(64), book: {
    productId: "BTC-USD", sourceProfileId: "fixture-spot", cacheStatus: "UNCACHED", sequence: "100",
    requestedAt: close + 60_001, receivedAt: close + 60_100, sourceObservedAt: close + 60_050,
    bids: [{ price: 99, quantity: 2 }], asks: [{ price: 101, quantity: 2 }],
  },
}, close + 60_200);

describe("P7 append-only ledger model", () => {
  it("registers only a future local-preparation manifest", () => {
    expect(initializeP7Ledger(manifest, close).ok).toBe(false);
    expect(initializeP7Ledger({ ...manifest, purpose: "PROSPECTIVE" as never }, close - 1).ok).toBe(false);
  });
  it("suspends a requested quote with missing durable response instead of refetching", () => {
    const state = step(intent(), { type: "REQUEST_QUOTE" });
    expect(planP7LedgerRecovery(state, "BTC-USD", close, close + 60_100)).toEqual({ action: "SUSPEND", reason: "QUOTE_RESPONSE_UNOBSERVED" });
    expect(applyP7LedgerCommand(state, command({ type: "REQUEST_QUOTE" }, "new-request"), close + 60_100).ok).toBe(false);
  });
  it("commits fill and balance as one model fact with no repeated terminal transition", () => {
    const state = quoted();
    const result = applyP7LedgerCommand(state, command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } }), close + 60_300);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.portfolio).toEqual({ cash: 9898.394, positionQuantity: 1, version: 1 });
    expect(planP7LedgerRecovery(result.value.state, "BTC-USD", close, close + 60_400).action).toBe("DONE");
    expect(applyP7LedgerCommand(result.value.state, command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } }, "second-fill"), close + 60_400).ok).toBe(false);
  });
  it("rejects wrong fees, oversized buys and unavailable quote evidence", () => {
    expect(applyP7LedgerCommand(quoted(), command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0 } }), close + 60_300).ok).toBe(false);
    expect(applyP7LedgerCommand(quoted(), command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 20_000, fee: 120 } }), close + 60_300).ok).toBe(false);
    const failed = step(step(intent(), { type: "REQUEST_QUOTE" }, close + 60_001), { type: "OBSERVE_QUOTE", book: null, bodySha256: "d".repeat(64) }, close + 60_200);
    expect(applyP7LedgerCommand(failed, command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } }), close + 60_300).ok).toBe(false);
  });
  it("keeps BTC and ETH independent and rejects stale portfolio versions", () => {
    const state = intent();
    expect(applyP7LedgerCommand(state, command({ type: "EXPECT" }, "eth-expect", "ETH-USD"), close + 60_100).ok).toBe(true);
    const admitted = step(step(fresh(), { type: "EXPECT" }), { type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) });
    expect(applyP7LedgerCommand(admitted, command({ type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 9 }), close + 60_100).ok).toBe(false);
  });
  it("keeps deadline inclusive for admission and strict for a missed decision", () => {
    const expected = step(fresh(), { type: "EXPECT" });
    expect(applyP7LedgerCommand(expected, command({ type: "TERMINATE", outcome: { kind: "MISSED" } }), close + 7_200_000).ok).toBe(false);
    expect(applyP7LedgerCommand(expected, command({ type: "TERMINATE", outcome: { kind: "MISSED" } }), close + 7_200_001).ok).toBe(true);
    expect(planP7LedgerRecovery(quoted(), "BTC-USD", close, close + 7_200_001).action).toBe("REJECT_EXPIRED_QUOTE");
  });
  it("requires an explicit proof-gap reason when resolving a lost response", () => {
    const state = step(intent(), { type: "REQUEST_QUOTE" });
    expect(applyP7LedgerCommand(state, command({ type: "TERMINATE", outcome: { kind: "QUOTE_REJECTED" } }), close + 60_100).ok).toBe(false);
    expect(applyP7LedgerCommand(state, command({ type: "TERMINATE", outcome: { kind: "QUOTE_REJECTED", reason: "QUOTE_RESPONSE_UNOBSERVED" } }), close + 60_100).ok).toBe(true);
  });
  it("does not promote a rejected book into a resume-pricing instruction", () => {
    const state = step(step(intent(), { type: "REQUEST_QUOTE" }, close + 60_001), { type: "OBSERVE_QUOTE", book: null, bodySha256: "d".repeat(64) }, close + 60_200);
    expect(planP7LedgerRecovery(state, "BTC-USD", close, close + 60_300).action).toBe("REJECT_INVALID_QUOTE");
  });
  it("rejects a second in-flight intent for the same product on another day", () => {
    let state = intent();
    const at = close + 86_400_000 + 60_000;
    for (const event of [{ type: "EXPECT" } as const, { type: "ADMIT", evaluatedAt: at - 1, windowSha256: "b".repeat(64) } as const]) {
      const result = applyP7LedgerCommand(state, { ...command(event, `next-${event.type}`), candleClosedAt: close + 86_400_000 }, at);
      if (!result.ok) throw new Error(result.error); state = result.value.state;
    }
    const result = applyP7LedgerCommand(state, { ...command({ type: "INTENT", side: "BUY", quantity: 1, portfolioVersion: 0 }, "next-intent"), candleClosedAt: close + 86_400_000 }, at);
    expect(result).toEqual({ ok: false, error: "PRODUCT_BUSY" });
  });
  it("preserves the original quote eligibility even if a replacement is fresher", () => {
    const state = quoted();
    expect(applyP7LedgerCommand(state, command({ type: "OBSERVE_QUOTE", bodySha256: "d".repeat(64), book: null }, "replacement-quote"), close + 60_300).ok).toBe(false);
    expect(applyP7LedgerCommand(state, command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } }), close + 7_200_001)).toEqual({ ok: false, error: "WINDOW_EXPIRED" });
  });
  it("keeps resolved HOLD and quote rejection balances unchanged", () => {
    const admitted = step(step(fresh(), { type: "EXPECT" }), { type: "ADMIT", evaluatedAt: close + 1, windowSha256: "b".repeat(64) });
    const result = applyP7LedgerCommand(admitted, command({ type: "TERMINATE", outcome: { kind: "HOLD" } }), close + 60_100);
    expect(result.ok && result.value.receipt.portfolio).toEqual({ cash: 10_000, positionQuantity: 0, version: 1 });
  });
  it("cannot sell more than the persisted position", () => {
    const bought = applyP7LedgerCommand(quoted(), command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 101, fee: 0.606 } }), close + 60_300);
    if (!bought.ok) throw new Error(bought.error);
    let state = bought.value.state;
    const nextClose = close + 86_400_000, at = nextClose + 60_000;
    const events: P7LedgerCommand["event"][] = [
      { type: "EXPECT" }, { type: "ADMIT", evaluatedAt: nextClose + 1, windowSha256: "b".repeat(64) },
      { type: "INTENT", side: "SELL", quantity: 2, portfolioVersion: 1 }, { type: "REQUEST_QUOTE" },
      { type: "OBSERVE_QUOTE", bodySha256: "d".repeat(64), book: { productId: "BTC-USD", sourceProfileId: "fixture-spot", cacheStatus: "UNCACHED", sequence: "101",
        requestedAt: at, receivedAt: at, sourceObservedAt: at, bids: [{ price: 99, quantity: 2 }], asks: [{ price: 101, quantity: 2 }] } },
    ];
    for (const event of events) {
      const result = applyP7LedgerCommand(state, { ...command(event, `sell-${event.type}`), candleClosedAt: nextClose }, at);
      if (!result.ok) throw new Error(result.error); state = result.value.state;
    }
    const result = applyP7LedgerCommand(state, { ...command({ type: "TERMINATE", outcome: { kind: "SIMULATED_FILL", price: 99, fee: 1.188 } }, "sell-fill"), candleClosedAt: nextClose }, at);
    expect(result).toEqual({ ok: false, error: "PORTFOLIO_INVARIANT_FAILED" });
  });
});
