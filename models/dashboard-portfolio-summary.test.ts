import { describe, expect, it } from "vitest";

import {
  projectDashboardPortfolioSummary,
  type DashboardPortfolioProductInput,
  type DashboardPortfolioSessionInput,
} from "./dashboard-portfolio-summary.js";

const productInput = (
  productId: string,
  overrides: Partial<DashboardPortfolioProductInput> = {},
): DashboardPortfolioProductInput => ({
  productId,
  phase: "waiting",
  status: "running",
  cash: 9_800,
  positionQuantity: 0,
  averagePrice: 0,
  dailyPnl: 0,
  maxGrossExposure: 20_000,
  lastCycle: null,
  ...overrides,
});

const sessionInput = (
  products: readonly DashboardPortfolioProductInput[],
  overrides: Partial<DashboardPortfolioSessionInput> = {},
): DashboardPortfolioSessionInput => ({
  phase: "running",
  killSwitchActive: false,
  portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 1_500 },
  products,
  ...overrides,
});

describe("dashboard portfolio summary projection", () => {
  it("answers single-product for a null portfolio session", () => {
    const result = projectDashboardPortfolioSummary(null);
    expect(result).toEqual({ ok: true, value: { kind: "single-product" } });
  });

  it("projects one product with exposure derived from the last known close", () => {
    const result = projectDashboardPortfolioSummary(
      sessionInput([
        productInput("BTC-USD", {
          cash: 5_000,
          positionQuantity: 0.1,
          averagePrice: 60_000,
          dailyPnl: 42.5,
          lastCycle: {
            cycleId: "cycle-1",
            triggeredAt: 1_700_000_000_000,
            completedAt: 1_700_000_004_000,
            outcome: "ORDER_CONFIRMED",
            marketPrice: 62_000,
          },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { value } = result;
    if (value.kind !== "portfolio") return expect.unreachable();
    expect(value.phase).toBe("running");
    expect(value.killSwitchActive).toBe(false);
    expect(value.products).toHaveLength(1);
    const product = value.products[0];
    expect(product).toMatchObject({
      productId: "BTC-USD",
      phase: "waiting",
      status: "running",
      grossExposure: 6_200, // |0.1| × 62 000 (marketPrice)
      maxGrossExposure: 20_000,
      dailyPnl: 42.5,
    });
    expect(value.consolidated).toEqual({
      grossExposure: 6_200,
      maxGrossExposure: 30_000,
      dailyPnl: 42.5,
      maxDailyLoss: 1_500,
    });
  });

  it("uses the average price when no market close is known", () => {
    const result = projectDashboardPortfolioSummary(
      sessionInput([
        productInput("BTC-USD", {
          cash: 4_000,
          positionQuantity: 0.1,
          averagePrice: 60_000,
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    if (value.kind !== "portfolio") return expect.unreachable();
    expect(value.products[0]).toMatchObject({
      marketPrice: null,
      grossExposure: 6_000, // |0.1| × 60 000 (averagePrice)
      lastCycle: null,
    });
  });

  it("sums N products in sorted productId order", () => {
    const result = projectDashboardPortfolioSummary(
      sessionInput([
        productInput("SOL-USD", { dailyPnl: -10.5, positionQuantity: 0, cash: 9_000 }),
        productInput("ETH-USD", {
          positionQuantity: 0.5,
          averagePrice: 3_000,
          dailyPnl: 30,
          lastCycle: {
            cycleId: "cycle-eth",
            triggeredAt: 1_700_000_100_000,
            completedAt: 1_700_000_104_000,
            outcome: "NO_ACTION",
            marketPrice: 3_100,
          },
        }),
        productInput("BTC-USD", {
          positionQuantity: 0.1,
          averagePrice: 60_000,
          dailyPnl: 12.25,
          lastCycle: {
            cycleId: "cycle-btc",
            triggeredAt: 1_700_000_000_000,
            completedAt: 1_700_000_004_000,
            outcome: "ORDER_CONFIRMED",
            marketPrice: 61_000,
          },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    if (value.kind !== "portfolio") return expect.unreachable();
    // S7 : produits présentés en ordre trié, sommes dans ce même ordre.
    expect(value.products.map((product) => product.productId)).toEqual([
      "BTC-USD",
      "ETH-USD",
      "SOL-USD",
    ]);
    expect(value.consolidated).toEqual({
      grossExposure: 6_100 + 1_550 + 0,
      maxGrossExposure: 30_000,
      dailyPnl: 12.25 + 30 + -10.5,
      maxDailyLoss: 1_500,
    });
  });

  it("keeps a quiescent product visible with its last known facts", () => {
    const result = projectDashboardPortfolioSummary(
      sessionInput(
        [
          productInput("BTC-USD", { positionQuantity: 0.1, averagePrice: 60_000 }),
          productInput("ETH-USD", {
            phase: "halted",
            status: "halted",
            cash: 8_000,
            positionQuantity: 0.2,
            averagePrice: 3_000,
            dailyPnl: -80,
            lastCycle: {
              cycleId: "cycle-eth-halted",
              triggeredAt: 1_700_000_200_000,
              completedAt: 1_700_000_204_000,
              outcome: "FAILED",
              marketPrice: 2_900,
            },
          }),
        ],
        { phase: "draining", killSwitchActive: true },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    if (value.kind !== "portfolio") return expect.unreachable();
    expect(value.phase).toBe("draining");
    expect(value.killSwitchActive).toBe(true);
    const quiescent = value.products.find((product) => product.productId === "ETH-USD");
    expect(quiescent).toMatchObject({
      status: "halted",
      phase: "halted",
      grossExposure: 580, // |0.2| × 2 900 (dernier close connu)
      dailyPnl: -80,
    });
    expect(quiescent?.lastCycle).toMatchObject({ outcome: "FAILED" });
  });

  it("fails closed on an incoherent portfolio session", () => {
    const valid = productInput("BTC-USD");
    const base = sessionInput([valid]);
    expect(
      projectDashboardPortfolioSummary(sessionInput([], { portfolioRisk: base.portfolioRisk })),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([valid, productInput("BTC-USD")]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(sessionInput([valid], { phase: "scheduling" })),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(sessionInput([valid], { killSwitchActive: "no" as unknown as boolean })),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(sessionInput([valid], { portfolioRisk: null })),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([productInput("BTC-USD", { phase: "waitingHard" })]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([productInput("BTC-USD", { status: "paused" as "running" })]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PORTFOLIO_SESSION" } });
  });

  it("fails closed on out-of-domain product facts", () => {
    const cases: Partial<DashboardPortfolioProductInput>[] = [
      { cash: Number.NaN },
      { positionQuantity: -0.1 },
      { averagePrice: -1 },
      { dailyPnl: Number.POSITIVE_INFINITY },
      { maxGrossExposure: 0 },
      {
        lastCycle: {
          cycleId: "cycle-1",
          triggeredAt: 1_700_000_000_000,
          completedAt: 1_700_000_004_000,
          outcome: "ORDER_CONFIRMED",
          marketPrice: 0,
        },
      },
      {
        lastCycle: {
          cycleId: "cycle-1",
          triggeredAt: 1.5,
          completedAt: 1_700_000_004_000,
          outcome: "ORDER_CONFIRMED",
          marketPrice: 60_000,
        },
      },
    ];
    for (const patch of cases) {
      expect(
        projectDashboardPortfolioSummary(sessionInput([productInput("BTC-USD", patch)])),
      ).toMatchObject({ ok: false, error: { code: "INVALID_PRODUCT_FACTS" } });
    }
  });

  it("fails closed on non-positive or non-finite consolidated limits", () => {
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([productInput("BTC-USD")], {
          portfolioRisk: { maxGrossExposure: 0, maxDailyLoss: 1_500 },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CONSOLIDATED_LIMITS" } });
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([productInput("BTC-USD")], {
          portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: -1 },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CONSOLIDATED_LIMITS" } });
    expect(
      projectDashboardPortfolioSummary(
        sessionInput([productInput("BTC-USD")], {
          portfolioRisk: { maxGrossExposure: Number.NaN, maxDailyLoss: 1_500 },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_CONSOLIDATED_LIMITS" } });
  });

  it("deterministically replays the same snapshot", () => {
    const session = sessionInput([
      productInput("ETH-USD", { dailyPnl: 5 }),
      productInput("BTC-USD", { dailyPnl: 7 }),
    ]);
    const first = projectDashboardPortfolioSummary(session);
    const second = projectDashboardPortfolioSummary(session);
    expect(second).toEqual(first);
  });
});
