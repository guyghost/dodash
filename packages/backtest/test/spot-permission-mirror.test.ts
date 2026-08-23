import { describe, expect, it } from "vitest";

import { createOrderIntent, createProductId, type OrderIntent } from "@dodash/domain";
import { resolveSpotPermission } from "@dodash/models";
import { checkRisk, type RiskConfig } from "@dodash/risk";

// Verrou de drift N1 (models/spot-prevalidation.review.md) : le
// prédicat de resolveSpotPermission doit rester l'image exacte de la
// branche SPOT_SHORT_FORBIDDEN de checkRisk.
describe("équivalence resolveSpotPermission / checkRisk SPOT_SHORT_FORBIDDEN", () => {
  const riskConfig: RiskConfig = {
    maxOrderNotional: 1e12,
    maxPositionNotional: 1e12,
    maxGrossExposure: 1e12,
    maxDailyLoss: 1e12,
    cooldownMs: 0,
    stopLossBps: 100,
    takeProfitBps: 100,
  };

  const product = createProductId("BTC-USD");
  if (!product.ok) throw new Error("invalid product fixture");

  const intentFor = (side: "BUY" | "SELL", quantity: number): OrderIntent => {
    const intent = createOrderIntent({
      clientOrderId: "mirror-test",
      decisionId: "mirror-test",
      strategyIds: ["fixture"],
      productId: product.value,
      side,
      type: "MARKET",
      quantity,
      limitPrice: null,
    });
    if (!intent.ok) throw new Error("invalid order fixture");
    return intent.value;
  };

  const riskFor = (order: OrderIntent, positionQuantity: number) => {
    const risk = checkRisk(
      order,
      {
        marketPrice: 100,
        currentPositionQuantity: positionQuantity,
        otherExposureNotional: 0,
        dailyPnl: 0,
        lastTradeAt: null,
        now: 1_704_067_201_000,
        killSwitchActive: false,
      },
      riskConfig,
    );
    if (!risk.ok) throw new Error("invalid risk fixture");
    return risk.value;
  };

  it("coïncide sur une grille (side × quantité × position)", () => {
    const quantities = [0.25, 0.5, 1, 1.5, 2, 10];
    const positions = [0, 0.25, 0.5, 1, 1.5, 2, 10];
    const sides = ["BUY", "SELL"] as const;
    for (const side of sides) {
      for (const quantity of quantities) {
        for (const positionQuantity of positions) {
          const permission = resolveSpotPermission(
            side,
            quantity,
            positionQuantity,
          );
          expect(permission.ok).toBe(true);
          if (!permission.ok) continue;
          const risk = riskFor(intentFor(side, quantity), positionQuantity);
          if (risk.status === "REJECTED") {
            // Plafonds infinis : seule la branche spot peut tirer.
            expect(risk.reasonCode).toBe("SPOT_SHORT_FORBIDDEN");
            expect(permission.value.status).toBe("INEXECUTABLE");
          } else {
            expect(permission.value.status).toBe("EXECUTABLE");
          }
        }
      }
    }
  });

  it("place les limites plafonnées hors du prédicat spot (jamais SPOT_SHORT)", () => {
    const risk = riskFor(intentFor("BUY", 100), 0);
    expect(risk.status).toBe("APPROVED");
    const permission = resolveSpotPermission("BUY", 100, 0);
    expect(permission.ok && permission.value.status).toBe("EXECUTABLE");
  });
});
