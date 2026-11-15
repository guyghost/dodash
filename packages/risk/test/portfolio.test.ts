import { describe, expect, it } from "vitest";

import {
  createOrderIntent,
  createProductId,
  type OrderIntent,
} from "@dodash/domain";

import {
  evaluatePortfolioRisk,
  type PortfolioProductRiskInput,
  type RiskSnapshot,
} from "../src/index.js";

const productId = (raw: string) => {
  const product = createProductId(raw);
  if (!product.ok) throw new Error("invalid product fixture");
  return product.value;
};

const intent = (
  raw: string,
  side: "BUY" | "SELL",
  quantity: number,
): OrderIntent => {
  const result = createOrderIntent({
    clientOrderId: `${raw}:${side}:${quantity}`,
    decisionId: "decision-1",
    strategyIds: ["rsi-reversion"],
    productId: productId(raw),
    side,
    type: "MARKET",
    quantity,
    limitPrice: null,
  });
  if (!result.ok) throw new Error("invalid order fixture");
  return result.value;
};

const config = {
  maxOrderNotional: 6_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 10_000,
  maxDailyLoss: 2_000,
  cooldownMs: 0,
  stopLossBps: 100,
  takeProfitBps: 200,
};

const snapshot = (overrides: Partial<RiskSnapshot> = {}): RiskSnapshot => ({
  ...baseSnapshot,
  ...overrides,
});

const baseSnapshot = {
  marketPrice: 50_000,
  currentPositionQuantity: 0,
  otherExposureNotional: 0,
  dailyPnl: 0,
  lastTradeAt: null,
  now: 100_000,
  killSwitchActive: false,
} as const;

const LIMITS = { maxGrossExposure: 12_000, maxDailyLoss: 1_500 } as const;

describe("evaluatePortfolioRisk", () => {
  it("rejette la somme dépassant le plafond consolidé, premier produit trié servi", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 4),
          snapshot: snapshot({ marketPrice: 1_500 }),
          config,
        },
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "BUY", 0.1),
          snapshot: snapshot(),
          config,
        },
      ],
      { ...LIMITS, maxGrossExposure: 10_500 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toEqual([
      {
        productId: "BTC-USD",
        decision: {
          status: "APPROVED",
          stopLossPrice: 49_500,
          takeProfitPrice: 51_000,
          projectedPositionNotional: 5_000,
          projectedGrossExposure: 5_000,
        },
      },
      {
        productId: "ETH-USD",
        decision: {
          status: "REJECTED",
          reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
        },
      },
    ]);
    expect(result.value.consolidatedGrossExposure).toBe(5_000);
  });

  it("approuve à l'égalité du plafond consolidé (rejet strictement au-delà)", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "BUY", 0.1),
          snapshot: snapshot(),
          config,
        },
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 3),
          snapshot: snapshot({ marketPrice: 2_000 }),
          config,
        },
      ],
      LIMITS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.decisions.map((outcome) => outcome.decision.status),
    ).toEqual(["APPROVED", "APPROVED"]);
    expect(result.value.consolidatedGrossExposure).toBe(11_000);
  });

  it("laisse quiescent un produit rejeté localement sans bloquer les autres", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "BUY", 0.1),
          snapshot: snapshot({ lastTradeAt: 50_000 }),
          config: { ...config, cooldownMs: 60_000 },
        },
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 1),
          snapshot: snapshot({ marketPrice: 2_000 }),
          config,
        },
      ],
      { ...LIMITS, maxGrossExposure: 20_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toEqual([
      {
        productId: "BTC-USD",
        decision: { status: "REJECTED", reasonCode: "COOLDOWN_ACTIVE" },
      },
      {
        productId: "ETH-USD",
        decision: expect.objectContaining({ status: "APPROVED" }),
      },
    ]);
  });

  it("rejette tous les produits à la perte quotidienne consolidée", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "BUY", 0.01),
          snapshot: snapshot({ dailyPnl: -1_000 }),
          config,
        },
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 1),
          snapshot: snapshot({ marketPrice: 2_000, dailyPnl: -600 }),
          config,
        },
      ],
      LIMITS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions).toEqual([
      {
        productId: "BTC-USD",
        decision: {
          status: "REJECTED",
          reasonCode: "CONSOLIDATED_DAILY_LOSS_LIMIT",
        },
      },
      {
        productId: "ETH-USD",
        decision: {
          status: "REJECTED",
          reasonCode: "CONSOLIDATED_DAILY_LOSS_LIMIT",
        },
      },
    ]);
    expect(result.value.consolidatedGrossExposure).toBe(0);
    expect(result.value.consolidatedDailyPnl).toBe(-1_600);
  });

  it("admet un ordre qui réduit l'exposition même portefeuille plafonné", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "SELL", 0.05),
          snapshot: snapshot({ currentPositionQuantity: 0.2 }),
          config,
        },
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 1),
          snapshot: snapshot({ marketPrice: 2_000 }),
          config,
        },
      ],
      LIMITS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions[0]?.decision.status).toBe("APPROVED");
    expect(result.value.consolidatedGrossExposure).toBe(9_500);
  });

  it("compte le socle d'exposition des produits sans ordre (NO_ORDER)", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: null,
          snapshot: snapshot({ currentPositionQuantity: 0.08 }),
          config,
        },
        {
          productId: "ETH-USD",
          intent: intent("ETH-USD", "BUY", 1),
          snapshot: snapshot({ marketPrice: 2_000 }),
          config,
        },
      ],
      LIMITS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions[0]).toEqual({
      productId: "BTC-USD",
      decision: { status: "NO_ORDER" },
    });
    expect(result.value.decisions[1]?.decision.status).toBe("APPROVED");
    expect(result.value.consolidatedGrossExposure).toBe(6_000);
  });

  it("produit les mêmes décisions quel que soit l'ordre d'entrée", () => {
    const inputs: readonly PortfolioProductRiskInput[] = [
      {
        productId: "BTC-USD",
        intent: intent("BTC-USD", "BUY", 0.1),
        snapshot: snapshot(),
        config,
      },
      {
        productId: "ETH-USD",
        intent: intent("ETH-USD", "BUY", 4),
        snapshot: snapshot({ marketPrice: 2_000 }),
        config,
      },
    ];
    const forward = evaluatePortfolioRisk(inputs, LIMITS);
    const reversed = evaluatePortfolioRisk([...inputs].reverse(), LIMITS);
    expect(forward.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(reversed.value).toEqual(forward.value);
  });

  it("rejette des limites non positives et des produits dupliqués", () => {
    expect(
      evaluatePortfolioRisk([], { maxGrossExposure: 0, maxDailyLoss: 1_000 }),
    ).toEqual({ ok: false, error: { code: "INVALID_PORTFOLIO_LIMITS" } });
    expect(
      evaluatePortfolioRisk([], {
        maxGrossExposure: Number.NaN,
        maxDailyLoss: 1_000,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_PORTFOLIO_LIMITS" } });

    const duplicated: readonly PortfolioProductRiskInput[] = [
      {
        productId: "BTC-USD",
        intent: intent("BTC-USD", "BUY", 0.01),
        snapshot: snapshot(),
        config,
      },
      {
        productId: "BTC-USD",
        intent: null,
        snapshot: snapshot(),
        config,
      },
    ];
    expect(evaluatePortfolioRisk(duplicated, LIMITS)).toEqual({
      ok: false,
      error: { code: "DUPLICATE_PORTFOLIO_PRODUCT", productId: "BTC-USD" },
    });
  });

  it("propage l'erreur de configuration d'un produit sans la corriger", () => {
    const result = evaluatePortfolioRisk(
      [
        {
          productId: "BTC-USD",
          intent: intent("BTC-USD", "BUY", 0.01),
          snapshot: snapshot(),
          config: { ...config, maxOrderNotional: 0 },
        },
      ],
      LIMITS,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_RISK_CONFIG" },
    });
  });
});
