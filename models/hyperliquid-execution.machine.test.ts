import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { hyperliquidPerpOrderMachine } from "./hyperliquid-execution.machine.js";
import type { PerpOrderIntent } from "./hyperliquid-execution.types.js";

const INTENT: PerpOrderIntent = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 1,
});

const CLIENT_ORDER_ID = "perp-2026-08-28-0001";

const createOrder = () =>
  createActor(hyperliquidPerpOrderMachine, { input: {} }).start();

const requestIntent = (
  actor: ReturnType<typeof createOrder>,
  overrides: Partial<{
    readonly intent: PerpOrderIntent;
    readonly admissionApproved: boolean;
    readonly dailyPnl: number;
    readonly positionQuantity: number;
    readonly otherGrossExposureNotional: number;
    readonly signerReady: boolean;
    readonly clientOrderId: string;
  }> = {},
) => {
  actor.send({
    type: "ORDER_INTENT_REQUESTED",
    intent: overrides.intent ?? INTENT,
    gate: {
      admissionApproved: overrides.admissionApproved ?? true,
      positionQuantity: overrides.positionQuantity ?? 0,
      dailyPnl: overrides.dailyPnl ?? 0,
      otherGrossExposureNotional: overrides.otherGrossExposureNotional ?? 0,
    },
    clientOrderId: overrides.clientOrderId ?? CLIENT_ORDER_ID,
    signerReady: overrides.signerReady ?? true,
  });
};

const happyPathToSubmitting = (actor: ReturnType<typeof createOrder>) => {
  requestIntent(actor);
  actor.send({ type: "INTENT_PERSIST_SUCCEEDED" });
  actor.send({ type: "ACTION_SIGNED" });
  expect(actor.getSnapshot().value).toBe("submitting");
};

describe("hyperliquidPerpOrderMachine", () => {
  it("refuse un ordre sans clé d'agent prête, sans effet", () => {
    const actor = createOrder();
    requestIntent(actor, { signerReady: false });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.lastRefusal).toBe(
      "AGENT_WALLET_NOT_READY",
    );
    expect(actor.getSnapshot().context.clientOrderId).toBeNull();
  });

  it("refuse un ordre hors admission ou hors garde de risque", () => {
    const actor = createOrder();
    requestIntent(actor, { admissionApproved: false });
    expect(actor.getSnapshot().context.lastRefusal).toBe(
      "PERP_ADMISSION_REQUIRED",
    );

    requestIntent(actor, { dailyPnl: -1_000 });
    expect(actor.getSnapshot().context.lastRefusal).toBe(
      "PERP_DAILY_LOSS_BREACHED",
    );
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("refuse un clientOrderId malformé", () => {
    const actor = createOrder();
    requestIntent(actor, { clientOrderId: "x" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.lastRefusal).toBe("PERP_INTENT_INVALID");
  });

  it("séquence persistance → signature → soumission → persistance → settled", () => {
    const actor = createOrder();
    requestIntent(actor);
    expect(actor.getSnapshot().value).toBe("persistingIntent");
    expect(actor.getSnapshot().context.clientOrderId).toBe(CLIENT_ORDER_ID);

    actor.send({ type: "ACTION_SIGNED" });
    expect(actor.getSnapshot().value).toBe("persistingIntent");

    actor.send({ type: "INTENT_PERSIST_SUCCEEDED" });
    expect(actor.getSnapshot().value).toBe("signing");

    actor.send({ type: "ACTION_SIGNED" });
    actor.send({ type: "SUBMIT_ACCEPTED" });
    expect(actor.getSnapshot().value).toBe("persistingOutcome");
    expect(actor.getSnapshot().context.outcome).toBe("ACCEPTED");

    actor.send({ type: "PERSIST_SUCCEEDED" });
    expect(actor.getSnapshot().value).toBe("settled");
  });

  it("n'est pas réceptif à un second ordre pendant le cycle", () => {
    const actor = createOrder();
    requestIntent(actor);
    requestIntent(actor, { intent: { ...INTENT, side: "SELL" } });
    expect(actor.getSnapshot().value).toBe("persistingIntent");
    expect(actor.getSnapshot().context.intent?.side).toBe("BUY");
  });

  it("persiste l'issue rejetée puis settle", () => {
    const actor = createOrder();
    happyPathToSubmitting(actor);
    actor.send({ type: "SUBMIT_REJECTED" });
    expect(actor.getSnapshot().context.outcome).toBe("REJECTED");
    actor.send({ type: "PERSIST_SUCCEEDED" });
    expect(actor.getSnapshot().value).toBe("settled");
  });

  it("réconcilie une issue inconnue sans jamais resoumettre", () => {
    const actor = createOrder();
    happyPathToSubmitting(actor);
    actor.send({ type: "SUBMIT_UNKNOWN" });
    expect(actor.getSnapshot().value).toBe("reconciling");

    actor.send({ type: "RECONCILIATION_RESOLVED", outcome: "ACCEPTED" });
    expect(actor.getSnapshot().context.outcome).toBe("ACCEPTED");
    expect(actor.getSnapshot().value).toBe("persistingOutcome");
  });

  it("échoue stable quand la réconciliation est impossible", () => {
    const actor = createOrder();
    happyPathToSubmitting(actor);
    actor.send({ type: "SUBMIT_UNKNOWN" });
    actor.send({
      type: "RECONCILIATION_FAILED",
      error: { code: "RECONCILIATION_FAILED" },
    });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "RECONCILIATION_FAILED",
    );

    actor.send({ type: "RESET" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.clientOrderId).toBeNull();
  });

  it("traite tout échec de phase comme failed exigeant un RESET", () => {
    const actor = createOrder();
    requestIntent(actor);
    actor.send({
      type: "INTENT_PERSIST_FAILED",
      error: { code: "PERSIST_INTENT_FAILED" },
    });
    expect(actor.getSnapshot().value).toBe("failed");

    actor.send({ type: "INTENT_PERSIST_SUCCEEDED" });
    expect(actor.getSnapshot().value).toBe("failed");
    actor.send({ type: "RESET" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("entre en réconciliation via la reprise sans jamais signer ni soumettre", () => {
    const order = createOrder();
    order.send({
      type: "ORDER_RECOVERY_REQUESTED",
      intent: INTENT,
      clientOrderId: CLIENT_ORDER_ID,
    });
    expect(order.getSnapshot().value).toBe("reconciling");
    expect(order.getSnapshot().context.clientOrderId).toBe(CLIENT_ORDER_ID);

    order.send({ type: "RECONCILIATION_RESOLVED", outcome: "ACCEPTED" });
    order.send({ type: "PERSIST_SUCCEEDED" });
    expect(order.getSnapshot().value).toBe("settled");
  });

  it("ignore une reprise au payload invalide", () => {
    const order = createOrder();
    order.send({
      type: "ORDER_RECOVERY_REQUESTED",
      intent: { ...INTENT, quantity: -1 },
      clientOrderId: CLIENT_ORDER_ID,
    });
    expect(order.getSnapshot().value).toBe("idle");
  });

  it("purge l'ordre local via RESET depuis settled", () => {
    const actor = createOrder();
    happyPathToSubmitting(actor);
    actor.send({ type: "SUBMIT_ACCEPTED" });
    actor.send({ type: "PERSIST_SUCCEEDED" });
    actor.send({ type: "RESET" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context).toEqual({
      clientOrderId: null,
      intent: null,
      outcome: null,
      lastRefusal: null,
      lastError: null,
    });
  });
});
