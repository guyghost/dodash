import { createOrderIntent, createProductId } from "@dodash/domain";
import { describe, expect, it } from "vitest";

import { executePaperOrder, type PaperPortfolio } from "../src/index.js";

const productId = createProductId("BTC-USD");
if (!productId.ok) throw new Error("invalid fixture product");

describe("executePaperOrder", () => {
  it("buys deterministically with configured fees and slippage", () => {
    const intent = createOrderIntent({
      clientOrderId: "paper-order-1",
      decisionId: "decision-1",
      strategyIds: ["ema-cross"],
      productId: productId.value,
      side: "BUY",
      type: "MARKET",
      quantity: 2,
      limitPrice: null,
    });
    if (!intent.ok) throw new Error("invalid fixture intent");
    const portfolio: PaperPortfolio = {
      cash: 1_000,
      positionQuantity: 0,
      averagePrice: 0,
    };

    const result = executePaperOrder(portfolio, intent.value, 100, 1, {
      feeBps: 10,
      slippageBps: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trade.fill.price).toBeCloseTo(100.2);
    expect(result.value.portfolio.positionQuantity).toBe(2);
    expect(result.value.portfolio.cash).toBeCloseTo(799.3996);
  });

  it("fills LIMIT orders at limitPrice with zero slippage and optional makerFeeBps", () => {
    const intent = createOrderIntent({
      clientOrderId: "paper-order-limit-1",
      decisionId: "decision-limit-1",
      strategyIds: ["rsi-reversion"],
      productId: productId.value,
      side: "BUY",
      type: "LIMIT",
      quantity: 2,
      limitPrice: 99,
    });
    if (!intent.ok) throw new Error("invalid fixture intent");
    const portfolio: PaperPortfolio = {
      cash: 1_000,
      positionQuantity: 0,
      averagePrice: 0,
    };

    const result = executePaperOrder(portfolio, intent.value, 100, 1, {
      feeBps: 10,
      slippageBps: 20,
      makerFeeBps: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trade.fill.price).toBe(99);
    expect(result.value.trade.fill.fee).toBeCloseTo(99 * 2 * 0.0002);
    expect(result.value.portfolio.cash).toBeCloseTo(1_000 - 198 - 99 * 2 * 0.0002);
  });

  it("rejects invalid makerFeeBps fail-closed", () => {
    const intent = createOrderIntent({
      clientOrderId: "paper-order-limit-2",
      decisionId: "decision-limit-2",
      strategyIds: ["ema-cross"],
      productId: productId.value,
      side: "BUY",
      type: "MARKET",
      quantity: 1,
      limitPrice: null,
    });
    if (!intent.ok) throw new Error("invalid fixture intent");
    const portfolio: PaperPortfolio = { cash: 1_000, positionQuantity: 0, averagePrice: 0 };

    expect(
      executePaperOrder(portfolio, intent.value, 100, 1, {
        feeBps: 10,
        slippageBps: 20,
        makerFeeBps: -1,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_BROKER_CONFIG" } });
    expect(
      executePaperOrder(portfolio, intent.value, 100, 1, {
        feeBps: 10,
        slippageBps: 20,
        makerFeeBps: 10_000,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_BROKER_CONFIG" } });
  });

  it("opens and covers a short position when allowShort is true and rejects otherwise", () => {
    const sellIntent = createOrderIntent({
      clientOrderId: "paper-short-open",
      decisionId: "decision-short-1",
      strategyIds: ["ema-cross"],
      productId: productId.value,
      side: "SELL",
      type: "MARKET",
      quantity: 2,
      limitPrice: null,
    });
    const buyCoverIntent = createOrderIntent({
      clientOrderId: "paper-short-close",
      decisionId: "decision-short-2",
      strategyIds: ["ema-cross"],
      productId: productId.value,
      side: "BUY",
      type: "MARKET",
      quantity: 2,
      limitPrice: null,
    });
    if (!sellIntent.ok || !buyCoverIntent.ok) throw new Error("invalid fixture intent");
    const flat: PaperPortfolio = { cash: 1_000, positionQuantity: 0, averagePrice: 0 };

    // Blocked by default when allowShort is omitted/false
    expect(
      executePaperOrder(flat, sellIntent.value, 100, 1, {
        feeBps: 10,
        slippageBps: 0,
      }),
    ).toEqual({ ok: false, error: { code: "INSUFFICIENT_POSITION" } });

    // Blocked when cash cannot cover margin of opening short
    expect(
      executePaperOrder({ cash: 50, positionQuantity: 0, averagePrice: 0 }, sellIntent.value, 100, 1, {
        feeBps: 10,
        slippageBps: 0,
        allowShort: true,
      }),
    ).toEqual({ ok: false, error: { code: "INSUFFICIENT_CASH" } });

    // Opens short when allowShort is true
    const opened = executePaperOrder(flat, sellIntent.value, 100, 1, {
      feeBps: 10,
      slippageBps: 0,
      allowShort: true,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.portfolio.positionQuantity).toBe(-2);
    expect(opened.value.portfolio.averagePrice).toBe(100);

    // Covers short at lower price -> positive realized PnL
    const covered = executePaperOrder(opened.value.portfolio, buyCoverIntent.value, 95, 2, {
      feeBps: 10,
      slippageBps: 0,
      allowShort: true,
    });
    expect(covered.ok).toBe(true);
    if (!covered.ok) return;
    expect(covered.value.portfolio.positionQuantity).toBe(0);
    expect(covered.value.portfolio.averagePrice).toBe(0);
    expect(covered.value.trade.closedQuantity).toBe(2);
    expect(covered.value.trade.realizedPnl).toBeCloseTo(10 - 95 * 2 * 0.001);
  });
});
