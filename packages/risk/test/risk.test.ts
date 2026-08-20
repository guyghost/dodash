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
});
