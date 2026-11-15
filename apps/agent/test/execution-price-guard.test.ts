import { err, ok } from "@dodash/domain";
import { describe, expect, it } from "vitest";

import { guardExecutionPrice } from "../src/execution-price-guard.js";

describe("guardExecutionPrice", () => {
  it("allows a Coinbase quote inside the threshold", () => {
    expect(
      guardExecutionPrice({
        productId: "BTC-USD",
        decisionPrice: 100,
        quote: ok(101),
        maxDivergenceBps: 200,
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("blocks the order when the quote diverges past the threshold", () => {
    expect(
      guardExecutionPrice({
        productId: "ETH-USD",
        decisionPrice: 100,
        quote: ok(103),
        maxDivergenceBps: 200,
      }),
    ).toEqual({
      ok: false,
      error: {
        phase: "execution",
        code: "ORDER_REJECTED",
        retryable: false,
        detail: "EXECUTION_PRICE_DIVERGENCE",
      },
    });
  });

  it("skips the order when Coinbase is rate limited without failing the decision code", () => {
    const result = guardExecutionPrice({
      productId: "ETH-USD",
      decisionPrice: 100,
      quote: err({ phase: "market-data", code: "RATE_LIMITED", retryable: true }),
      maxDivergenceBps: 200,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        phase: "execution",
        code: "ORDER_REJECTED",
        retryable: false,
        detail: "EXECUTION_QUOTE_UNAVAILABLE",
      },
    });
  });
});
