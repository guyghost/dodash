import { describe, expect, it } from "vitest";

import {
  admitHyperliquidPerpConfiguration,
  assessPerpOrderIntent,
  floorToSizeIncrement,
  HYPERLIQUID_PERP_POLICY,
} from "./hyperliquid-execution.js";
import type { HyperliquidPerpCandidate, PerpOrderIntent } from "./hyperliquid-execution.types.js";

const BTC: PerpOrderIntent = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

const gate = (overrides: Partial<Parameters<typeof assessPerpOrderIntent>[1]> = {}) =>
  Object.freeze({
    admissionApproved: true,
    positionQuantity: 0,
    dailyPnl: 0,
    otherGrossExposureNotional: 0,
    ...overrides,
  });

const candidate = (
  overrides: Partial<HyperliquidPerpCandidate> = {},
): HyperliquidPerpCandidate => ({
  executionMode: "live",
  venue: "HYPERLIQUID",
  productId: "BTC-PERP",
  timeframe: "ONE_DAY",
  maxLeverage: 2,
  risk: { ...HYPERLIQUID_PERP_POLICY.risk },
  ...overrides,
});

describe("HYPERLIQUID_PERP_POLICY", () => {
  it("fige l'enveloppe confirmée par l'opérateur", () => {
    expect(HYPERLIQUID_PERP_POLICY.id).toBe("HYPERLIQUID_PERP_2026_08");
    expect([...HYPERLIQUID_PERP_POLICY.products]).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(HYPERLIQUID_PERP_POLICY.maxLeverage).toBe(2);
    expect(HYPERLIQUID_PERP_POLICY.timeframe).toBe("ONE_DAY");
    expect(HYPERLIQUID_PERP_POLICY.risk).toEqual({
      maxOrderNotional: 600,
      maxPositionNotional: 10_000,
      maxGrossExposure: 10_000,
      maxDailyLoss: 1_000,
    });
  });
});

describe("admitHyperliquidPerpConfiguration", () => {
  it("approuve l'enveloppe exacte", () => {
    expect(admitHyperliquidPerpConfiguration(candidate())).toEqual({
      status: "APPROVED",
    });
  });

  it("exclut le mode paper de la politique", () => {
    expect(
      admitHyperliquidPerpConfiguration(candidate({ executionMode: "paper" })),
    ).toEqual({ status: "OUT_OF_SCOPE" });
  });

  it("refuse un marché hors allowlist", () => {
    expect(
      admitHyperliquidPerpConfiguration(candidate({ productId: "SOL-PERP" })),
    ).toEqual({ status: "REJECTED", reasonCode: "PERP_PRODUCT_NOT_ALLOWED" });
  });

  it("refuse tout champ différent de l'enveloppe figée", () => {
    const cases: ReadonlyArray<Partial<HyperliquidPerpCandidate>> = [
      { venue: "DERIVE" },
      { timeframe: "FIVE_MINUTE" },
      { maxLeverage: 3 },
      { risk: { ...HYPERLIQUID_PERP_POLICY.risk, maxOrderNotional: 700 } },
      { risk: { ...HYPERLIQUID_PERP_POLICY.risk, maxDailyLoss: 2_000 } },
    ];
    for (const override of cases) {
      expect(admitHyperliquidPerpConfiguration(candidate(override))).toEqual({
        status: "REJECTED",
        reasonCode: "PERP_POLICY_MISMATCH",
      });
    }
  });
});

describe("assessPerpOrderIntent", () => {
  it("approuve une intention dans l'enveloppe", () => {
    expect(assessPerpOrderIntent(BTC, gate())).toEqual({ status: "EXECUTABLE" });
  });

  it("refuse une intention malformée", () => {
    const cases: ReadonlyArray<PerpOrderIntent> = [
      { ...BTC, quantity: 0 },
      { ...BTC, quantity: -0.001 },
      { ...BTC, markPrice: 0 },
      { ...BTC, leverage: 1.5 },
      { ...BTC, leverage: 0 },
      { ...BTC, productId: "SOL-PERP" },
    ];
    for (const intent of cases) {
      const assessment = assessPerpOrderIntent(intent, gate());
      expect(assessment).toEqual({
        status: "REFUSED",
        reasonCode: "PERP_INTENT_INVALID",
      });
    }
  });

  it("exige l'admission avant tout ordre", () => {
    expect(
      assessPerpOrderIntent(BTC, gate({ admissionApproved: false })),
    ).toEqual({ status: "REFUSED", reasonCode: "PERP_ADMISSION_REQUIRED" });
  });

  it("applique le coupe-circuit journalier avant toute taille", () => {
    expect(assessPerpOrderIntent(BTC, gate({ dailyPnl: -1_000 }))).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_DAILY_LOSS_BREACHED",
    });
    expect(assessPerpOrderIntent(BTC, gate({ dailyPnl: -999.99 }))).toEqual({
      status: "EXECUTABLE",
    });
  });

  it("refuse un levier au-delà de 2x", () => {
    expect(assessPerpOrderIntent({ ...BTC, leverage: 3 }, gate())).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_LEVERAGE_EXCEEDED",
    });
  });

  it("refuse un ordre au-delà de 600 USD", () => {
    expect(assessPerpOrderIntent({ ...BTC, quantity: 0.007 }, gate())).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_ORDER_NOTIONAL_EXCEEDED",
    });
    expect(assessPerpOrderIntent({ ...BTC, quantity: 0.006 }, gate())).toEqual({
      status: "EXECUTABLE",
    });
  });

  it("refuse une position résultante au-delà de 10 000 USD, long comme short", () => {
    const nearCap = gate({ positionQuantity: 0.095 });
    expect(
      assessPerpOrderIntent({ ...BTC, quantity: 0.006 }, nearCap),
    ).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_POSITION_EXCEEDED",
    });

    const headroom = gate({ positionQuantity: 0.09 });
    expect(assessPerpOrderIntent({ ...BTC, quantity: 0.006 }, headroom)).toEqual({
      status: "EXECUTABLE",
    });

    const short = assessPerpOrderIntent(
      { ...BTC, side: "SELL", quantity: 0.006 },
      gate({ positionQuantity: -0.095 }),
    );
    expect(short).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_POSITION_EXCEEDED",
    });
  });

  it("agrège l'exposition brute avec les autres produits", () => {
    const crowded = gate({ otherGrossExposureNotional: 9_600 });
    expect(assessPerpOrderIntent(BTC, crowded)).toEqual({
      status: "REFUSED",
      reasonCode: "PERP_EXPOSURE_EXCEEDED",
    });
    const headroom = gate({ otherGrossExposureNotional: 9_400 });
    expect(assessPerpOrderIntent(BTC, headroom)).toEqual({
      status: "EXECUTABLE",
    });
  });

  it("nettoie l'exposition propre du produit avant d'agréger", () => {
    const existing = gate({
      positionQuantity: 0.05,
      otherGrossExposureNotional: 5_000,
    });
    expect(
      assessPerpOrderIntent({ ...BTC, quantity: 0.001 }, existing).status,
    ).toBe("EXECUTABLE");
  });
});

describe("floorToSizeIncrement", () => {
  it("arrondit toujours vers zéro", () => {
    expect(floorToSizeIncrement("BTC-PERP", 0.123456)).toBeCloseTo(0.12345, 10);
    expect(floorToSizeIncrement("ETH-PERP", 1.23456)).toBeCloseTo(1.2345, 10);
  });

  it("abandonne les résidus sous un incrément", () => {
    expect(floorToSizeIncrement("BTC-PERP", 0.000001)).toBe(0);
    expect(floorToSizeIncrement("ETH-PERP", 0.00001)).toBe(0);
  });

  it("ignore les entrées invalides", () => {
    expect(floorToSizeIncrement("BTC-PERP", -1)).toBe(0);
    expect(floorToSizeIncrement("BTC-PERP", Number.NaN)).toBe(0);
  });
});
