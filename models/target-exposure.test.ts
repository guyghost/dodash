import { describe, expect, it } from "vitest";

import {
  annualizedRealizedVolatility,
  planTargetExposure,
  simpleMovingAverage,
  TARGET_EXPOSURE_MIN_CANDLES,
  TARGET_EXPOSURE_POLICY,
  targetExposureRiskGate,
  type TargetExposureCandle,
} from "./target-exposure.js";

const DAY = 86_400_000;
// 2025-01-06 est un lundi UTC.
const MONDAY = Date.UTC(2025, 0, 6);

/** Série de clôtures journalières ; la dernière bougie débute à `lastStart`. */
const series = (closes: readonly number[], lastStart: number): TargetExposureCandle[] =>
  closes.map((close, index) => ({ start: lastStart - (closes.length - 1 - index) * DAY, close }));

/** Hausse régulière avec une oscillation de ±`swing` (volatilité contrôlée). */
const rising = (count: number, swing = 0.01): number[] =>
  Array.from({ length: count }, (_, index) => 100 * 1.002 ** index * (index % 2 === 0 ? 1 + swing : 1 - swing));

const base = { feeBps: 60, slippageBps: 2 } as const;

describe("indicateurs", () => {
  it("calcule la moyenne simple sur la fenêtre incluant la dernière clôture", () => {
    expect(simpleMovingAverage([1, 2, 3, 4], 2)).toBe(3.5);
    expect(simpleMovingAverage([1, 2], 3)).toBeNull();
  });

  it("annualise l'écart-type échantillon des rendements simples (√365)", () => {
    const closes = [100, 110, 99, 108.9];
    const returns = [0.1, -0.1, 0.1];
    const mean = returns.reduce((sum, value) => sum + value, 0) / 3;
    const sd = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 2);
    expect(annualizedRealizedVolatility(closes, 3)).toBeCloseTo(sd * Math.sqrt(365), 10);
    expect(annualizedRealizedVolatility(closes, 4)).toBeNull();
  });
});

describe("planTargetExposure", () => {
  it("fige la politique P7", () => {
    expect(TARGET_EXPOSURE_POLICY).toEqual({
      volTarget: 0.5,
      trendSmaPeriod: 200,
      volPeriod: 30,
      driftThreshold: 0.1,
      minOrderNotional: 10,
    });
    expect(TARGET_EXPOSURE_MIN_CANDLES).toBe(240);
  });

  it("n'émet aucun ordre sur historique insuffisant (INV-T4)", () => {
    const decision = planTargetExposure({ ...base, candles: series(rising(200), MONDAY), positionQuantity: 0, cash: 10_000 });
    expect(decision).toMatchObject({ side: "HOLD", quantity: 0, reason: "INSUFFICIENT_HISTORY" });
  });

  it("achète jusqu'à la cible à l'ancre du lundi, plafonné au cash net de frais (INV-T2)", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), MONDAY);
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 0, cash: 10_000 });
    expect(decision.trend).toBe(true);
    // Volatilité faible ⇒ cible plafonnée à 100 % du créneau.
    expect(decision.target).toBe(1);
    expect(decision.reason).toBe("ANCHOR");
    expect(decision.side).toBe("BUY");
    const price = candles.at(-1)?.close ?? 0;
    expect(decision.quantity * price).toBeCloseTo(10_000 / (1.0002 * 1.006), 4);
  });

  it("réduit l'exposition quand la volatilité dépasse la cible", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.04), MONDAY);
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 0, cash: 10_000 });
    expect(decision.trend).toBe(true);
    expect(decision.vol30).toBeGreaterThan(0.5);
    expect(decision.target).toBeCloseTo(0.5 / (decision.vol30 ?? 1), 10);
  });

  it("vend tout au passage sous la SMA200, même avec un cash nul (INV-T3)", () => {
    const closes = rising(TARGET_EXPOSURE_MIN_CANDLES - 1, 0.001);
    closes.push(50); // chute sous la moyenne : changement de tendance
    const candles = series(closes, MONDAY + 3 * DAY); // jeudi
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 80, cash: 0 });
    expect(decision).toMatchObject({ trend: false, target: 0, reason: "ANCHOR", side: "SELL" });
    expect(decision.quantity).toBe(80);
  });

  it("tient la cible figée entre deux ancres et ne trade pas dans la bande", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), MONDAY + 2 * DAY); // mercredi
    const price = candles.at(-1)?.close ?? 0;
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 9_500 / price, cash: 500 });
    expect(decision.anchorStart).toBe(MONDAY);
    expect(decision).toMatchObject({ side: "HOLD", reason: "IN_BAND" });
  });

  it("rééquilibre hors ancre quand la dérive dépasse 10 points", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), MONDAY + 2 * DAY);
    const price = candles.at(-1)?.close ?? 0;
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 8_000 / price, cash: 2_000 });
    expect(decision).toMatchObject({ side: "BUY", reason: "DRIFT" });
  });

  it("rééquilibre le premier jour du mois", () => {
    const firstOfMonth = Date.UTC(2025, 1, 1); // samedi 2025-02-01
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), firstOfMonth);
    const price = candles.at(-1)?.close ?? 0;
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 9_500 / price, cash: 500 });
    expect(decision).toMatchObject({ side: "BUY", reason: "MONTH_START" });
  });

  it("ignore un rééquilibrage inférieur au montant minimal", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), MONDAY);
    const price = candles.at(-1)?.close ?? 0;
    const decision = planTargetExposure({ ...base, candles, positionQuantity: 9_935 / price, cash: 5 });
    expect(decision).toMatchObject({ side: "HOLD", reason: "BELOW_MIN_ORDER", quantity: 0 });
  });

  it("refuse une série discontinue", () => {
    const candles = series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.001), MONDAY);
    const gapped = [...candles.slice(0, 100), ...candles.slice(101)];
    const decision = planTargetExposure({ ...base, candles: gapped, positionQuantity: 0, cash: 10_000 });
    expect(decision).toMatchObject({ side: "HOLD", reason: "INSUFFICIENT_HISTORY" });
  });

  it("est pure : mêmes entrées, même décision (INV-T1)", () => {
    const input = { ...base, candles: series(rising(TARGET_EXPOSURE_MIN_CANDLES, 0.02), MONDAY), positionQuantity: 10, cash: 5_000 };
    expect(planTargetExposure(input)).toEqual(planTargetExposure(input));
  });
});

describe("targetExposureRiskGate (INV-T7)", () => {
  it("neutralise la perte journalière et l'admission pour une réduction", () => {
    expect(targetExposureRiskGate("SELL", -9_000)).toEqual({ dailyPnlForRisk: 0, portfolioAdmission: false });
  });

  it("laisse un achat soumis aux deux gardes", () => {
    expect(targetExposureRiskGate("BUY", -9_000)).toEqual({ dailyPnlForRisk: -9_000, portfolioAdmission: true });
  });
});
