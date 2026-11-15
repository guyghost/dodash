import { describe, expect, it } from "vitest";

import {
  DASHBOARD_PERP_PNL_MAX_ORDERS,
  projectDashboardPerpPnlHistory,
  type DashboardPerpFillRow,
  type DashboardPerpOrderRow,
} from "./hyperliquid-fill-persistence.js";

const INTENT_JSON = JSON.stringify({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

const orderRow = (
  clientOrderId: string,
  overrides: Partial<DashboardPerpOrderRow> = {},
): DashboardPerpOrderRow => ({
  clientOrderId,
  intentJson: INTENT_JSON,
  outcome: "ACCEPTED",
  settledAt: 1_700_000_000_000,
  ...overrides,
});

const fillRow = (
  clientOrderId: string,
  fill: {
    readonly fillId: string;
    readonly side: "BUY" | "SELL";
    readonly price: number;
    readonly quantity: number;
    readonly fee: number;
    readonly closedPnl: number;
    readonly fillTime: number;
  },
): DashboardPerpFillRow => ({
  clientOrderId,
  fillJson: JSON.stringify(fill),
});

const buyFill = (fillTime: number): Parameters<typeof fillRow>[1] => ({
  fillId: "1001",
  side: "BUY",
  price: 100_000,
  quantity: 0.005,
  fee: 0.25,
  closedPnl: 0,
  fillTime,
});

describe("projectDashboardPerpPnlHistory", () => {
  it("projette les fills et les agrégats PnL sur des fixtures fermées", () => {
    const result = projectDashboardPerpPnlHistory(
      [
        orderRow("perp-00000002", { settledAt: 1_700_000_100_000 }),
        orderRow("perp-00000001"),
      ],
      [
        // SELL qui clôt la position : PnL réalisé positif, frais nettoyés.
        fillRow("perp-00000002", {
          fillId: "1002",
          side: "SELL",
          price: 101_000,
          quantity: 0.005,
          fee: 0.25,
          closedPnl: 5,
          fillTime: 1_700_000_090_000,
        }),
        fillRow("perp-00000001", buyFill(1_700_000_010_000)),
      ],
      30,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        fills: [
          {
            clientOrderId: "perp-00000002",
            fillId: "1002",
            productId: "BTC-PERP",
            side: "SELL",
            price: 101_000,
            quantity: 0.005,
            fee: 0.25,
            realizedPnl: 4.75,
            fillTime: 1_700_000_090_000,
          },
          {
            clientOrderId: "perp-00000001",
            fillId: "1001",
            productId: "BTC-PERP",
            side: "BUY",
            price: 100_000,
            quantity: 0.005,
            fee: 0.25,
            realizedPnl: -0.25,
            fillTime: 1_700_000_010_000,
          },
        ],
        totalRealizedPnl: 4.5,
        totalFee: 0.5,
      },
    });
  });

  it("expose les fills du plus récent au plus ancien", () => {
    const result = projectDashboardPerpPnlHistory(
      [orderRow("perp-00000001")],
      [
        fillRow("perp-00000001", { ...buyFill(1_000), fillId: "1001" }),
        fillRow("perp-00000001", { ...buyFill(3_000), fillId: "1003" }),
        fillRow("perp-00000001", { ...buyFill(2_000), fillId: "1002" }),
      ],
      30,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fills.map((fill) => fill.fillId)).toEqual([
        "1003",
        "1002",
        "1001",
      ]);
    }
  });

  it("ignore un fill dont l'ordre est hors fenêtre", () => {
    const result = projectDashboardPerpPnlHistory(
      [orderRow("perp-00000001")],
      [
        fillRow("perp-00000001", buyFill(1_000)),
        fillRow("perp-00000099", { ...buyFill(2_000), fillId: "1002" }),
      ],
      30,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fills).toHaveLength(1);
      expect(result.value.totalRealizedPnl).toBe(-0.25);
    }
  });

  it("projette une fenêtre vide sans erreur", () => {
    const result = projectDashboardPerpPnlHistory([], [], 30);
    expect(result).toEqual({
      ok: true,
      value: { fills: [], totalRealizedPnl: 0, totalFee: 0 },
    });
  });

  it("rejette un limit hors bornes [1, 50]", () => {
    expect(
      projectDashboardPerpPnlHistory([], [], 0).ok,
    ).toBe(false);
    expect(
      projectDashboardPerpPnlHistory([], [], DASHBOARD_PERP_PNL_MAX_ORDERS + 1)
        .ok,
    ).toBe(false);
    expect(
      projectDashboardPerpPnlHistory([], [], 1.5).ok,
    ).toBe(false);
    // Plus de lignes que la fenêtre demandée : contradiction SQL.
    expect(
      projectDashboardPerpPnlHistory(
        [orderRow("perp-00000001"), orderRow("perp-00000002")],
        [],
        1,
      ).ok,
    ).toBe(false);
  });

  it("rejette en échec typé global une ligne d'ordre malformée", () => {
    const cases: readonly DashboardPerpOrderRow[] = [
      orderRow(""),
      orderRow("perp-00000001", { outcome: "UNKNOWN" }),
      orderRow("perp-00000001", { settledAt: 1.5 }),
      { ...orderRow("perp-00000001"), intentJson: 42 as unknown as string },
    ];
    for (const row of cases) {
      const result = projectDashboardPerpPnlHistory([row], [], 30);
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_PERP_ORDER_ROW" },
      });
    }
  });

  it("rejette une intention persistée illisible ou hors domaine", () => {
    const result = projectDashboardPerpPnlHistory(
      [orderRow("perp-00000001", { intentJson: "{broken" })],
      [],
      30,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_PERP_INTENT_JSON" },
    });
    const invalid = projectDashboardPerpPnlHistory(
      [
        orderRow("perp-00000001", {
          intentJson: JSON.stringify({
            productId: "BTC-PERP",
            side: "BUY",
            quantity: -1,
            markPrice: 100_000,
            leverage: 1,
          }),
        }),
      ],
      [],
      30,
    );
    expect(invalid).toEqual({
      ok: false,
      error: { code: "INVALID_PERP_INTENT_JSON" },
    });
  });

  it("rejette en échec typé global une ligne de fill malformée", () => {
    expect(
      projectDashboardPerpPnlHistory([orderRow("perp-00000001")], [{ clientOrderId: "", fillJson: "{}" }], 30),
    ).toEqual({ ok: false, error: { code: "INVALID_PERP_FILL_ROW" } });
  });

  it("rejette un JSON de fill hors domaine — jamais de valeur inventée", () => {
    const cases: readonly string[] = [
      "{broken",
      JSON.stringify({ ...buyFill(1_000), price: 0 }),
      JSON.stringify({ ...buyFill(1_000), quantity: -0.001 }),
      JSON.stringify({ ...buyFill(1_000), fee: -1 }),
      JSON.stringify({ ...buyFill(1_000), closedPnl: "x" }),
      JSON.stringify({ ...buyFill(1_000), fillTime: 1.5 }),
      JSON.stringify({ ...buyFill(1_000), side: "X" }),
      JSON.stringify({ ...buyFill(1_000), fillId: "" }),
    ];
    for (const fillJson of cases) {
      const result = projectDashboardPerpPnlHistory(
        [orderRow("perp-00000001")],
        [{ clientOrderId: "perp-00000001", fillJson }],
        30,
      );
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_PERP_FILL_JSON" },
      });
    }
  });

  it("projette un PnL réalisé négatif tel quel, sans arrondi ni bornage", () => {
    const result = projectDashboardPerpPnlHistory(
      [orderRow("perp-00000001")],
      [
        fillRow("perp-00000001", {
          fillId: "1002",
          side: "SELL",
          price: 99_000,
          quantity: 0.005,
          fee: 0.3,
          closedPnl: -5,
          fillTime: 1_000,
        }),
      ],
      30,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalRealizedPnl).toBe(-5.3);
      expect(result.value.totalFee).toBe(0.3);
    }
  });
});
