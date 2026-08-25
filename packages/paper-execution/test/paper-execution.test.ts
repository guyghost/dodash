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
});
