import { describe, expect, it } from "vitest";

import {
  DASHBOARD_PNL_HISTORY_MAX_CYCLES,
  projectDashboardPnlHistory,
  type DashboardPnlCycleRow,
  type DashboardPnlOrderRow,
} from "./dashboard-pnl-history.js";

const t0 = 1_700_000_000_000;

const cycleRow = (
  cycleId: string,
  triggeredAt: number,
  artifacts: Record<string, unknown>,
): DashboardPnlCycleRow => ({
  cycleId,
  triggeredAt,
  completedAt: triggeredAt + 4_000,
  outcome: "ORDER_CONFIRMED",
  artifactsJson: JSON.stringify(artifacts),
});

const orderRow = (
  clientOrderId: string,
  cycleId: string,
  submission: Record<string, unknown>,
): DashboardPnlOrderRow => ({
  clientOrderId,
  cycleId,
  status: "CONFIRMED",
  executionJson: JSON.stringify(submission),
});

const market = (close: number) => ({
  market: { productId: "BTC-USD", timeframe: "FIVE_MINUTE", candles: [{ close }] },
});

const buyPlan = (stop: number, take: number) => ({
  risk: {
    status: "APPROVED",
    stopLossPrice: stop,
    takeProfitPrice: take,
    projectedPositionNotional: 1_000,
    projectedGrossExposure: 1_000,
  },
});

const buyIntent = (quantity: number) => ({
  clientOrderId: `order-${quantity}`,
  decisionId: "decision-1",
  strategyIds: ["breakout"],
  productId: "BTC-USD",
  side: "BUY",
  type: "MARKET",
  quantity,
  limitPrice: null,
});

const confirmedSubmission = (
  portfolio: { cash: number; positionQuantity: number; averagePrice: number },
  fill: { price: number; quantity: number; fee: number },
  protectiveOrderId?: string,
) => ({
  status: "CONFIRMED",
  exchangeOrderId: "exchange-1",
  portfolio,
  fill,
  ...(protectiveOrderId === undefined ? {} : { protectiveOrderId }),
});

describe("projectDashboardPnlHistory", () => {
  it("projects an empty window as an empty read-only projection", () => {
    const result = projectDashboardPnlHistory([], [], 30);
    expect(result).toEqual({
      ok: true,
      value: {
        equityCurve: [],
        cycles: [],
        openPosition: null,
        protection: null,
      },
    });
  });

  it("aggregates equity, fees, realized pnl and slippage over a buy then sell", () => {
    const cycles = [
      cycleRow("cycle-buy", t0, {
        ...market(60_000),
        order: {
          clientOrderId: "order-1",
          decisionId: "decision-1",
          strategyIds: ["breakout"],
          productId: "BTC-USD",
          side: "BUY",
          type: "MARKET",
          quantity: 0.1,
          limitPrice: null,
        },
        ...buyPlan(58_000, 63_000),
      }),
      cycleRow("cycle-hold", t0 + 300_000, market(61_000)),
      cycleRow("cycle-sell", t0 + 600_000, {
        ...market(62_000),
        order: {
          clientOrderId: "order-2",
          decisionId: "decision-2",
          strategyIds: ["breakout"],
          productId: "BTC-USD",
          side: "SELL",
          type: "MARKET",
          quantity: 0.1,
          limitPrice: null,
        },
      }),
    ];
    const orders = [
      orderRow(
        "order-1",
        "cycle-buy",
        confirmedSubmission(
          { cash: 401.5, positionQuantity: 0.1, averagePrice: 60_098.5 },
          { price: 60_060, quantity: 0.1, fee: 1.5 },
          "protective-1",
        ),
      ),
      orderRow(
        "order-2",
        "cycle-sell",
        confirmedSubmission(
          { cash: 1_619.5, positionQuantity: 0, averagePrice: 0 },
          { price: 62_010, quantity: 0.1, fee: 2 },
        ),
      ),
    ];

    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");

    // Équité : post-trade marquée au close du cycle, ordre chronologique.
    expect(result.value.equityCurve).toEqual([
      { t: t0, equity: 401.5 + 0.1 * 60_000 },
      { t: t0 + 300_000, equity: 401.5 + 0.1 * 61_000 },
      { t: t0 + 600_000, equity: 1_619.5 },
    ]);

    // Cycles : plus récent d'abord.
    expect(result.value.cycles.map((cycle) => cycle.cycleId)).toEqual([
      "cycle-sell",
      "cycle-hold",
      "cycle-buy",
    ]);

    const buy = result.value.cycles[2];
    if (buy === undefined) throw new Error("buy cycle missing");
    expect(buy.side).toBe("BUY");
    expect(buy.quantity).toBe(0.1);
    expect(buy.fillPrice).toBe(60_060);
    expect(buy.fee).toBe(1.5);
    expect(buy.realizedPnl).toBeNull();
    // Slippage BUY au-dessus du mark = défavorable = positif.
    expect(buy.slippageBps).toBeCloseTo(((60_060 - 60_000) / 60_000) * 10_000, 9);

    const hold = result.value.cycles[1];
    if (hold === undefined) throw new Error("hold cycle missing");
    expect(hold.side).toBeNull();
    expect(hold.fee).toBeNull();
    expect(hold.marketPrice).toBe(61_000);

    const sell = result.value.cycles[0];
    if (sell === undefined) throw new Error("sell cycle missing");
    // Réalisé : (62_010 − 60_098,5) × 0,1 − 2.
    expect(sell.realizedPnl).toBeCloseTo((62_010 - 60_098.5) * 0.1 - 2, 9);
    // Slippage SELL sous le mark = défavorable = positif.
    expect(sell.slippageBps).toBeCloseTo(((62_000 - 62_010) / 62_000) * 10_000, 9);

    // Position close : plus de protection exposée.
    expect(result.value.openPosition).toBeNull();
    expect(result.value.protection).toBeNull();
  });

  it("exposes the latest confirmed buy protection while the position stays open", () => {
    const cycles = [
      cycleRow("cycle-1", t0, {
        ...market(60_000),
        order: buyIntent(0.1),
        ...buyPlan(58_000, 63_000),
      }),
      cycleRow("cycle-2", t0 + 300_000, {
        ...market(61_000),
        order: buyIntent(0.2),
        ...buyPlan(58_800, 64_000),
      }),
    ];
    const orders = [
      orderRow(
        "order-1",
        "cycle-1",
        confirmedSubmission(
          { cash: 401.5, positionQuantity: 0.1, averagePrice: 60_098.5 },
          { price: 60_060, quantity: 0.1, fee: 1.5 },
          "protective-1",
        ),
      ),
      orderRow(
        "order-2",
        "cycle-2",
        confirmedSubmission(
          { cash: -698.5, positionQuantity: 0.2, averagePrice: 60_098.5 },
          { price: 61_050, quantity: 0.1, fee: 1.6 },
          "protective-2",
        ),
      ),
    ];

    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");
    expect(result.value.openPosition).toEqual({
      quantity: 0.2,
      averagePrice: 60_098.5,
    });
    expect(result.value.protection).toEqual({
      stopLossPrice: 58_800,
      takeProfitPrice: 64_000,
      protectiveOrderConfirmed: true,
    });
  });

  it("fails closed on an open position without any known protection", () => {
    const cycles = [cycleRow("cycle-1", t0, market(60_000))];
    const orders = [
      orderRow(
        "order-1",
        "cycle-1",
        confirmedSubmission(
          { cash: 401.5, positionQuantity: 0.1, averagePrice: 60_098.5 },
          { price: 60_060, quantity: 0.1, fee: 1.5 },
        ),
      ),
    ];
    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");
    expect(result.value.openPosition).not.toBeNull();
    expect(result.value.protection).toBeNull();
  });

  it("consumes non-carrying statuses without inventing facts", () => {
    const cycles = [cycleRow("cycle-1", t0, market(60_000))];
    const orders = [
      orderRow("order-1", "cycle-1", { status: "REJECTED" }),
      orderRow("order-2", "cycle-1", {
        status: "TERMINAL_FAILED",
        exchangeOrderId: null,
        fill: null,
      }),
    ];
    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");
    expect(result.value.equityCurve).toEqual([]);
    const hold = result.value.cycles[0];
    if (hold === undefined) throw new Error("cycle missing");
    expect(hold.side).toBeNull();
    expect(result.value.openPosition).toBeNull();
  });

  it("treats a protection failure fill as a realized sell", () => {
    const cycles = [
      cycleRow("cycle-1", t0, {
        ...market(60_000),
        ...buyPlan(58_000, 63_000),
      }),
      cycleRow("cycle-2", t0 + 300_000, market(55_000)),
    ];
    const orders = [
      orderRow(
        "order-1",
        "cycle-1",
        confirmedSubmission(
          { cash: 401.5, positionQuantity: 0.1, averagePrice: 60_098.5 },
          { price: 60_060, quantity: 0.1, fee: 1.5 },
          "protective-1",
        ),
      ),
      orderRow("order-2", "cycle-2", {
        status: "PROTECTION_FAILED",
        exchangeOrderId: "exchange-9",
        portfolio: { cash: 949.5, positionQuantity: 0, averagePrice: 0 },
        fill: { price: 55_001, quantity: 0.1, fee: 1.1 },
        protectiveOrderId: "protective-1",
      }),
    ];
    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");
    const sell = result.value.cycles[0]; // plus récent d'abord
    if (sell === undefined) throw new Error("sell cycle missing");
    expect(sell.side).toBe("SELL"); // sortie de vente inférée du fill forcé
    expect(sell.realizedPnl).toBeCloseTo((55_001 - 60_098.5) * 0.1 - 1.1, 9);
    expect(result.value.openPosition).toBeNull();
  });

  it("keeps a confirmed fill without fill facts portfolio-only", () => {
    const cycles = [cycleRow("cycle-1", t0, market(60_000))];
    const orders = [
      orderRow("order-1", "cycle-1", {
        status: "CONFIRMED",
        exchangeOrderId: "perp-1",
        portfolio: { cash: 1_000, positionQuantity: 0, averagePrice: 0 },
        fill: null,
      }),
    ];
    const result = projectDashboardPnlHistory(cycles, orders, 30);
    if (!result.ok) throw new Error("projection must succeed");
    const perp = result.value.cycles[0];
    if (perp === undefined) throw new Error("cycle missing");
    expect(perp.side).toBeNull();
    expect(result.value.equityCurve).toEqual([
      { t: t0, equity: 1_000 },
    ]);
  });

  it("bounds the window and rejects cycles beyond the limit", () => {
    const cycle = cycleRow("cycle-1", t0, market(60_000));
    expect(
      projectDashboardPnlHistory([], [], DASHBOARD_PNL_HISTORY_MAX_CYCLES).ok,
    ).toBe(true);
    expect(
      projectDashboardPnlHistory([], [], DASHBOARD_PNL_HISTORY_MAX_CYCLES + 1),
    ).toEqual({ ok: false, error: { code: "INVALID_LIMIT" } });
    expect(projectDashboardPnlHistory([], [], 0)).toEqual({
      ok: false,
      error: { code: "INVALID_LIMIT" },
    });
    expect(projectDashboardPnlHistory([], [], 1.5)).toEqual({
      ok: false,
      error: { code: "INVALID_LIMIT" },
    });
    expect(projectDashboardPnlHistory([cycle, cycle], [], 1)).toEqual({
      ok: false,
      error: { code: "INVALID_LIMIT" },
    });
  });

  it("fails closed on malformed raw records instead of projecting partial data", () => {
    const base = { cash: 1, positionQuantity: 0, averagePrice: 0 };
    const cases: readonly [
      readonly DashboardPnlCycleRow[],
      readonly DashboardPnlOrderRow[],
      // biome-ignore lint/suspicious/noExplicitAny: typage des erreurs attendues
      any,
    ][] = [
      [
        [{ ...cycleRow("c", t0, market(60_000)), cycleId: "" }],
        [],
        "INVALID_CYCLE_ROW",
      ],
      [
        [{ ...cycleRow("c", t0, market(60_000)), triggeredAt: -1 }],
        [],
        "INVALID_CYCLE_ROW",
      ],
      [
        [cycleRow("c", t0, market(60_000)), { ...cycleRow("c2", t0 + 1, market(1)), outcome: "" }],
        [],
        "INVALID_CYCLE_ROW",
      ],
      [[cycleRow("c", t0, {})], [], null],
      [
        [{ ...cycleRow("c", t0, market(60_000)), artifactsJson: "{not json" }],
        [],
        "INVALID_ARTIFACTS_JSON",
      ],
      [
        [cycleRow("c", t0, { market: { candles: [{ close: -1 }] } })],
        [],
        "INVALID_ARTIFACTS_JSON",
      ],
      [
        [cycleRow("c", t0, { risk: { status: "APPROVED", stopLossPrice: 1 } })],
        [],
        "INVALID_ARTIFACTS_JSON",
      ],
      [
        [cycleRow("c", t0, market(60_000))],
        [{ ...orderRow("o", "c", { status: "CONFIRMED" }), clientOrderId: "" }],
        "INVALID_ORDER_ROW",
      ],
      [
        [cycleRow("c", t0, market(60_000))],
        [orderRow("o", "c", { status: "MYSTERY" })],
        "INVALID_EXECUTION_JSON",
      ],
      [
        [cycleRow("c", t0, market(60_000))],
        [orderRow("o", "c", { status: "CONFIRMED", portfolio: { cash: "1" } })],
        "INVALID_EXECUTION_JSON",
      ],
      [
        [cycleRow("c", t0, market(60_000))],
        [
          orderRow("o", "c", {
            status: "CONFIRMED",
            portfolio: base,
            fill: { price: 0, quantity: 1, fee: 1 },
          }),
        ],
        "INVALID_EXECUTION_JSON",
      ],
    ];
    for (const [cycles, orders, code] of cases) {
      const result = projectDashboardPnlHistory(cycles, orders, 30);
      if (code === null) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, error: { code } });
      }
    }
  });
});
