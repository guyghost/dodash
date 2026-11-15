import { describe, expect, it } from "vitest";

import { createOrderIntent, createProductId, type OrderIntent } from "@dodash/domain";

import { checkRisk } from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");
const intentResult = createOrderIntent({
  clientOrderId: "order-1",
  decisionId: "decision-1",
  strategyIds: ["rsi"],
  productId: product.value,
  side: "BUY",
  type: "MARKET",
  quantity: 0.01,
  limitPrice: null,
});
if (!intentResult.ok) throw new Error("invalid order fixture");
const intent: OrderIntent = intentResult.value;

const config = {
  maxOrderNotional: 1_000,
  maxPositionNotional: 5_000,
  maxGrossExposure: 10_000,
  maxDailyLoss: 500,
  cooldownMs: 60_000,
  stopLossBps: 100,
  takeProfitBps: 200,
} as const;

const snapshot = {
  marketPrice: 50_000,
  currentPositionQuantity: 0,
  otherExposureNotional: 0,
  dailyPnl: 0,
  lastTradeAt: null,
  now: 100_000,
  killSwitchActive: false,
} as const;

describe("checkRisk", () => {
  it("approuve et calcule les protections", () => {
    const result = checkRisk(intent, snapshot, config);
    expect(result.ok && result.value.status).toBe("APPROVED");
    if (!result.ok || result.value.status !== "APPROVED") return;
    expect(result.value.stopLossPrice).toBe(49_500);
    expect(result.value.takeProfitPrice).toBe(51_000);
  });

  it("donne la priorité au kill switch", () => {
    const result = checkRisk(
      intent,
      { ...snapshot, killSwitchActive: true, dailyPnl: -1_000 },
      config,
    );
    expect(result.ok && result.value).toEqual({
      status: "REJECTED",
      reasonCode: "KILL_SWITCH_ACTIVE",
    });
  });

  it("refuse pendant le cooldown", () => {
    const result = checkRisk(
      intent,
      { ...snapshot, lastTradeAt: 90_000 },
      config,
    );
    expect(result.ok && result.value).toEqual({
      status: "REJECTED",
      reasonCode: "COOLDOWN_ACTIVE",
    });
  });

  it("refuse une position projetée excessive", () => {
    const result = checkRisk(
      intent,
      { ...snapshot, currentPositionQuantity: 0.1 },
      config,
    );
    expect(result.ok && result.value).toEqual({
      status: "REJECTED",
      reasonCode: "POSITION_NOTIONAL_LIMIT",
    });
  });

  it("une vente peut réduire une position longue", () => {
    const sell = { ...intent, side: "SELL" as const };
    const result = checkRisk(
      sell,
      { ...snapshot, currentPositionQuantity: 0.05 },
      config,
    );
    expect(result.ok && result.value.status).toBe("APPROVED");
  });

  it("refuse une vente qui créerait une position short sur le spot", () => {
    const sell = { ...intent, side: "SELL" as const };
    const result = checkRisk(
      sell,
      { ...snapshot, currentPositionQuantity: 0.005 },
      config,
    );
    expect(result.ok && result.value).toEqual({
      status: "REJECTED",
      reasonCode: "SPOT_SHORT_FORBIDDEN",
    });
  });

  it("calcule stopLossPrice et takeProfitPrice dynamiques via ATR pour un BUY", () => {
    const result = checkRisk(
      intent,
      { ...snapshot, atr: 1_000 },
      { ...config, atrStopLossMultiple: 1.5, atrTakeProfitMultiple: 3 },
    );
    expect(result.ok && result.value.status).toBe("APPROVED");
    if (!result.ok || result.value.status !== "APPROVED") return;
    // atrStopDist = (1_000 * 1.5) / 50_000 = 0.03 -> 50_000 * 0.97 = 48_500
    // atrTakeDist = (1_000 * 3) / 50_000 = 0.06 -> 50_000 * 1.06 = 53_000
    expect(result.value.stopLossPrice).toBeCloseTo(48_500, 10);
    expect(result.value.takeProfitPrice).toBeCloseTo(53_000, 10);
  });

  it("calcule stopLossPrice et takeProfitPrice dynamiques via ATR pour un SELL", () => {
    const sell = { ...intent, side: "SELL" as const };
    const result = checkRisk(
      sell,
      { ...snapshot, currentPositionQuantity: 0.05, atr: 1_000 },
      { ...config, atrStopLossMultiple: 2, atrTakeProfitMultiple: 4 },
    );
    expect(result.ok && result.value.status).toBe("APPROVED");
    if (!result.ok || result.value.status !== "APPROVED") return;
    // atrStopDist = 0.04 -> 50_000 * 1.04 = 52_000
    // atrTakeDist = 0.08 -> 50_000 * 0.92 = 46_000
    expect(result.value.stopLossPrice).toBeCloseTo(52_000, 10);
    expect(result.value.takeProfitPrice).toBeCloseTo(46_000, 10);
  });

  it("conserve le comportement V1 si le jeu de paramètres ATR est incomplet", () => {
    const withOnlyAtr = checkRisk(intent, { ...snapshot, atr: 1_000 }, config);
    expect(withOnlyAtr.ok && withOnlyAtr.value.status).toBe("APPROVED");
    if (withOnlyAtr.ok && withOnlyAtr.value.status === "APPROVED") {
      expect(withOnlyAtr.value.stopLossPrice).toBe(49_500);
      expect(withOnlyAtr.value.takeProfitPrice).toBe(51_000);
    }

    const missingTpMultiple = checkRisk(
      intent,
      { ...snapshot, atr: 1_000 },
      { ...config, atrStopLossMultiple: 2 },
    );
    expect(missingTpMultiple.ok && missingTpMultiple.value.status).toBe("APPROVED");
    if (missingTpMultiple.ok && missingTpMultiple.value.status === "APPROVED") {
      expect(missingTpMultiple.value.stopLossPrice).toBe(49_500);
      expect(missingTpMultiple.value.takeProfitPrice).toBe(51_000);
    }
  });

  it("borne les distances ATR extrêmes à 0.9999 pour SL et 9.9999 pour TP", () => {
    const result = checkRisk(
      intent,
      { ...snapshot, atr: 100_000 },
      { ...config, atrStopLossMultiple: 2, atrTakeProfitMultiple: 10 },
    );
    expect(result.ok && result.value.status).toBe("APPROVED");
    if (!result.ok || result.value.status !== "APPROVED") return;
    expect(result.value.stopLossPrice).toBeCloseTo(50_000 * (1 - 0.9999), 10);
    expect(result.value.stopLossPrice).toBeGreaterThan(0);
    expect(result.value.takeProfitPrice).toBeCloseTo(50_000 * (1 + 9.9999), 10);
  });

  it("rejette fail-closed un atr ou des multiples ATR invalides", () => {
    expect(checkRisk(intent, { ...snapshot, atr: 0 }, config)).toEqual({
      ok: false,
      error: { code: "INVALID_RISK_SNAPSHOT" },
    });
    expect(checkRisk(intent, { ...snapshot, atr: Number.NaN }, config)).toEqual({
      ok: false,
      error: { code: "INVALID_RISK_SNAPSHOT" },
    });
    expect(
      checkRisk(intent, snapshot, { ...config, atrStopLossMultiple: -1 }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_RISK_CONFIG" },
    });
    expect(
      checkRisk(intent, snapshot, { ...config, atrTakeProfitMultiple: Infinity }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_RISK_CONFIG" },
    });
  });
});
