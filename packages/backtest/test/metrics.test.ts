import { describe, expect, it } from "vitest";

import type { PaperTrade } from "../src/paper-broker.js";
import { calculateMetrics } from "../src/metrics.js";

const trade = (price: number, quantity: number, fee: number): PaperTrade => ({
  fill: {
    fillId: `fill-${price}-${quantity}`,
    clientOrderId: "client",
    exchangeOrderId: "exchange",
    price,
    quantity,
    fee,
    executedAt: 1,
  },
  closedQuantity: 0,
  realizedPnl: 0,
});

describe("backtest turnover metrics", () => {
  it("rapporte le notionnel échangé brut relativement au capital initial", () => {
    const metrics = calculateMetrics(
      [{ at: 1, equity: 1_000 }],
      [trade(100, 2, 1), trade(50, 3, 0.5)],
      1_000,
    );

    expect(metrics.grossTradedNotional).toBe(350);
    expect(metrics.turnover).toBe(0.35);
    expect(metrics.fees).toBe(1.5);
  });

  it("retourne un turnover nul sans fill", () => {
    const metrics = calculateMetrics([{ at: 1, equity: 1_000 }], [], 1_000);

    expect(metrics.grossTradedNotional).toBe(0);
    expect(metrics.turnover).toBe(0);
  });
});
