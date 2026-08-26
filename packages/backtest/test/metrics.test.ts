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

const closedTrade = (realizedPnl: number): PaperTrade => ({
  ...trade(100, 1, 0),
  closedQuantity: 1,
  realizedPnl,
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

describe("win rate liquidatif", () => {
  it("est égal au win rate par fills sans position terminale (INV-26)", () => {
    const metrics = calculateMetrics(
      [{ at: 1, equity: 1_000 }],
      [closedTrade(50), closedTrade(-20)],
      1_000,
      0,
    );

    expect(metrics.winRate).toBe(0.5);
    expect(metrics.winRateLiquidative).toBe(metrics.winRate);
  });

  it("compte une position terminale perdante comme une perte supplémentaire", () => {
    // realized = +50 ; equity finale 900 ⇒ unrealized = -150.
    const metrics = calculateMetrics(
      [{ at: 1, equity: 1_000 }, { at: 2, equity: 900 }],
      [closedTrade(50)],
      1_000,
      5,
    );

    expect(metrics.winRate).toBe(1);
    expect(metrics.winRateLiquidative).toBe(0.5);
  });

  it("compte une position terminale gagnante comme un gain supplémentaire", () => {
    // realized = -20 ; equity finale 1_030 ⇒ unrealized = +50.
    const metrics = calculateMetrics(
      [{ at: 1, equity: 1_000 }, { at: 2, equity: 1_030 }],
      [closedTrade(-20)],
      1_000,
      3,
    );

    expect(metrics.winRate).toBe(0);
    expect(metrics.winRateLiquidative).toBe(0.5);
  });

  it("compte une position terminale au pair au dénominateur seulement", () => {
    // realized = +50 ; equity finale 1_050 ⇒ unrealized = 0.
    const metrics = calculateMetrics(
      [{ at: 1, equity: 1_000 }, { at: 2, equity: 1_050 }],
      [closedTrade(50)],
      1_000,
      2,
    );

    expect(metrics.winRateLiquidative).toBe(0.5);
  });

  it("expose un win rate liquidatif nul sans fill ni position", () => {
    const metrics = calculateMetrics([{ at: 1, equity: 1_000 }], [], 1_000);

    expect(metrics.winRateLiquidative).toBe(0);
  });
});
