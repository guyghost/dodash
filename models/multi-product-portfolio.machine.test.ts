import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  multiProductPortfolioMachine,
  type MultiProductPortfolioEvent,
} from "./multi-product-portfolio.machine.js";

type PortfolioActor = ReturnType<
  typeof createActor<typeof multiProductPortfolioMachine>
>;

const LIMITS = { maxGrossExposure: 10_000, maxDailyLoss: 1_000 } as const;

const createPortfolioActor = (
  products: readonly string[] = ["BTC-USD", "ETH-USD"],
  limits = LIMITS,
): PortfolioActor =>
  createActor(multiProductPortfolioMachine, {
    input: { products, limits },
  }).start();

const send = (
  actor: PortfolioActor,
  ...events: MultiProductPortfolioEvent[]
): void => {
  for (const event of events) actor.send(event);
};

const start = (actor: PortfolioActor): void => {
  actor.send({ type: "PORTFOLIO_STARTED" });
};

const snapshot = (actor: PortfolioActor) => actor.getSnapshot();

const lastDecision = (actor: PortfolioActor) =>
  snapshot(actor).context.lastDecision;

describe("multiProductPortfolioMachine", () => {
  it("rejette fail-closed une entrée invalide (doublon, liste vide, limite non positive)", () => {
    const duplicate = createActor(multiProductPortfolioMachine, {
      input: { products: ["BTC-USD", "BTC-USD"], limits: LIMITS },
    }).start();
    expect(duplicate.getSnapshot().matches("rejected")).toBe(true);

    const empty = createActor(multiProductPortfolioMachine, {
      input: { products: [], limits: LIMITS },
    }).start();
    expect(empty.getSnapshot().matches("rejected")).toBe(true);

    const nonPositive = createActor(multiProductPortfolioMachine, {
      input: {
        products: ["BTC-USD"],
        limits: { maxGrossExposure: 0, maxDailyLoss: 1_000 },
      },
    }).start();
    expect(nonPositive.getSnapshot().matches("rejected")).toBe(true);
  });

  it("normalise les produits triés dès la création du contexte", () => {
    const actor = createPortfolioActor(["ETH-USD", "BTC-USD"]);
    expect(snapshot(actor).context.products).toEqual(["BTC-USD", "ETH-USD"]);
  });

  it("admet une proposition sous les plafonds et commit l'exposition du produit", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(actor, {
      type: "PRODUCT_EXPOSURE_REPORTED",
      productId: "BTC-USD",
      grossExposure: 3_000,
      dailyPnl: 50,
    });
    send(actor, { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 4_000 });
    expect(lastDecision(actor)).toEqual({
      productId: "ETH-USD",
      approved: true,
      reasonCode: null,
    });
    expect(snapshot(actor).context.exposure).toEqual({
      "BTC-USD": 3_000,
      "ETH-USD": 4_000,
    });
  });

  it("rejette au plafond consolidé et ne commit pas la proposition rejetée (INV-P1)", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(
      actor,
      {
        type: "PRODUCT_EXPOSURE_REPORTED",
        productId: "BTC-USD",
        grossExposure: 6_000,
        dailyPnl: 0,
      },
      { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 5_000 },
    );
    expect(lastDecision(actor)).toEqual({
      productId: "ETH-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
    });
    expect(snapshot(actor).context.exposure["ETH-USD"]).toBe(0);
  });

  it("admets une réduction d'exposition même au plafond, puis borne la marge restante (INV-P1)", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(
      actor,
      {
        type: "PRODUCT_EXPOSURE_REPORTED",
        productId: "BTC-USD",
        grossExposure: 9_500,
        dailyPnl: 0,
      },
      { type: "RISK_PROPOSED", productId: "BTC-USD", proposedGrossExposure: 4_000 },
    );
    expect(lastDecision(actor)?.approved).toBe(true);
    send(actor, { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 6_500 });
    expect(lastDecision(actor)).toEqual({
      productId: "ETH-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
    });
    send(actor, { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 6_000 });
    expect(lastDecision(actor)?.approved).toBe(true);
  });

  it("coupe tout le portefeuille à la perte quotidienne consolidée (INV-P2)", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(
      actor,
      {
        type: "PRODUCT_EXPOSURE_REPORTED",
        productId: "BTC-USD",
        grossExposure: 1_000,
        dailyPnl: -700,
      },
      {
        type: "PRODUCT_EXPOSURE_REPORTED",
        productId: "ETH-USD",
        grossExposure: 1_000,
        dailyPnl: -400,
      },
      { type: "RISK_PROPOSED", productId: "BTC-USD", proposedGrossExposure: 1_000 },
    );
    expect(lastDecision(actor)).toEqual({
      productId: "BTC-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_DAILY_LOSS_LIMIT",
    });
  });

  it("garantit la quiescence par produit : un produit en échec ne bloque pas les autres (INV-P3)", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(
      actor,
      { type: "PRODUCT_FAILED", productId: "BTC-USD" },
      { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 1_000 },
    );
    expect(lastDecision(actor)?.approved).toBe(true);
    expect(snapshot(actor).context.statuses["BTC-USD"]).toBe("failed");
    expect(snapshot(actor).matches("running")).toBe(true);
  });

  it("passe en complete quand tous les produits sont quiescents (INV-P3)", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(
      actor,
      { type: "PRODUCT_STOPPED", productId: "BTC-USD" },
      { type: "PRODUCT_STOPPED", productId: "ETH-USD" },
    );
    expect(snapshot(actor).matches("complete")).toBe(true);
    send(actor, { type: "RESET" });
    expect(snapshot(actor).matches("idle")).toBe(true);
  });

  it("applique le kill switch portefeuille : plus aucune admission jusqu'à halted", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(actor, { type: "KILL_SWITCH_ENGAGED", controlId: "  " });
    expect(snapshot(actor).matches("running")).toBe(true);
    expect(snapshot(actor).context.lastError).toEqual({
      code: "CONTROL_PERMISSION_REQUIRED",
    });

    send(actor, { type: "KILL_SWITCH_ENGAGED", controlId: "kill-1" });
    expect(snapshot(actor).matches("draining")).toBe(true);
    expect(snapshot(actor).context.killSwitchActive).toBe(true);

    send(actor, { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 1 });
    expect(lastDecision(actor)).toEqual({
      productId: "ETH-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_KILL_SWITCH",
    });

    send(
      actor,
      { type: "PRODUCT_STOPPED", productId: "BTC-USD" },
      { type: "PRODUCT_STOPPED", productId: "ETH-USD" },
    );
    expect(snapshot(actor).matches("halted")).toBe(true);
    send(actor, { type: "RESET" });
    expect(snapshot(actor).matches("idle")).toBe(true);
  });

  it("rejette un produit inconnu avec un motif explicite", () => {
    const actor = createPortfolioActor();
    start(actor);
    send(actor, { type: "RISK_PROPOSED", productId: "SOL-USD", proposedGrossExposure: 1 });
    expect(lastDecision(actor)).toEqual({
      productId: "SOL-USD",
      approved: false,
      reasonCode: "UNKNOWN_PRODUCT",
    });
    send(actor, { type: "PRODUCT_STOPPED", productId: "SOL-USD" });
    expect(snapshot(actor).context.lastError).toEqual({ code: "UNKNOWN_PRODUCT" });
  });

  it("détermine les décisions indépendamment de l'ordre de rapport des expositions (INV-P4)", () => {
    const build = () => {
      const actor = createPortfolioActor();
      start(actor);
      send(
        actor,
        {
          type: "PRODUCT_EXPOSURE_REPORTED",
          productId: "ETH-USD",
          grossExposure: 6_000,
          dailyPnl: 0,
        },
        {
          type: "PRODUCT_EXPOSURE_REPORTED",
          productId: "BTC-USD",
          grossExposure: 0,
          dailyPnl: 0,
        },
        { type: "RISK_PROPOSED", productId: "ETH-USD", proposedGrossExposure: 5_000 },
        { type: "RISK_PROPOSED", productId: "BTC-USD", proposedGrossExposure: 5_500 },
      );
      return actor;
    };
    const first = build();
    const second = build();
    const project = (actor: PortfolioActor) => {
      const value = snapshot(actor);
      return JSON.stringify({
        exposure: value.context.exposure,
        lastDecision: value.context.lastDecision,
      });
    };
    expect(project(first)).toBe(project(second));
    expect(lastDecision(first)).toEqual({
      productId: "BTC-USD",
      approved: false,
      reasonCode: "CONSOLIDATED_GROSS_EXPOSURE_LIMIT",
    });
  });
});
