import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { perpOrderUiMachine } from "./perp-order-ui.machine.js";
import type {
  PerpOrderFormDraft,
  PerpOrderUiPermissions,
} from "./perp-order-ui.types.js";

const permissions: PerpOrderUiPermissions = Object.freeze({
  canControl: true,
  canTrade: true,
});

const DRAFT: PerpOrderFormDraft = Object.freeze({
  productId: "BTC-PERP",
  side: "BUY",
  quantity: 0.005,
  markPrice: 100_000,
  leverage: 2,
  dailyPnl: 0,
});

const createUi = () =>
  createActor(perpOrderUiMachine, { input: {} }).start();

const prepare = (
  actor: ReturnType<typeof createUi>,
  draft: PerpOrderFormDraft = DRAFT,
  perms: PerpOrderUiPermissions = permissions,
) => actor.send({ type: "SUBMISSION_PREPARED", draft, permissions: perms });

describe("perpOrderUiMachine", () => {
  it("exige des permissions de contrôle et de trade dès la préparation", () => {
    const actor = createUi();
    prepare(actor, DRAFT, { canControl: true, canTrade: false });
    expect(actor.getSnapshot().value).toBe("form");
    expect(actor.getSnapshot().context.lastRefusal).toBe(
      "PERP_PERMISSIONS_REQUIRED",
    );
  });

  it("refuse tout brouillon hors enveloppe avant la confirmation", () => {
    const actor = createUi();
    const cases: ReadonlyArray<{ draft: PerpOrderFormDraft; code: string }> = [
      { draft: { ...DRAFT, productId: "SOL-PERP" as PerpOrderFormDraft["productId"] }, code: "PERP_DRAFT_PRODUCT" },
      { draft: { ...DRAFT, leverage: 3 }, code: "PERP_DRAFT_LEVERAGE" },
      { draft: { ...DRAFT, quantity: 0 }, code: "PERP_DRAFT_QUANTITY" },
      { draft: { ...DRAFT, markPrice: -1 }, code: "PERP_DRAFT_PRICE" },
      { draft: { ...DRAFT, dailyPnl: Number.NaN }, code: "PERP_DRAFT_DAILY_PNL" },
    ];
    for (const { draft, code } of cases) {
      prepare(actor, draft);
      expect(actor.getSnapshot().value).toBe("form");
      expect(actor.getSnapshot().context.lastRefusal).toBe(code);
    }
  });

  it("confirme puis soumet avec le clientOrderId du shell", () => {
    const actor = createUi();
    prepare(actor);
    expect(actor.getSnapshot().value).toBe("confirming");
    expect(actor.getSnapshot().context.clientOrderId).toBeNull();

    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    expect(actor.getSnapshot().value).toBe("submitting");
    expect(actor.getSnapshot().context.clientOrderId).toBe("perp-abc12345");

    actor.send({
      type: "SUBMISSION_SUCCEEDED",
      result: {
        status: "SETTLED",
        outcome: "ACCEPTED",
        clientOrderId: "perp-abc12345",
      },
    });
    expect(actor.getSnapshot().value).toBe("result");
    expect(actor.getSnapshot().context.result?.status).toBe("SETTLED");
  });

  it("n'est pas réceptif pendant submitting (pas de double soumission)", () => {
    const actor = createUi();
    prepare(actor);
    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    expect(actor.getSnapshot().value).toBe("submitting");
    actor.send({ type: "SUBMISSION_PREPARED", draft: DRAFT, permissions });
    expect(actor.getSnapshot().value).toBe("submitting");
  });

  it("annule à la confirmation sans générer d'identifiant", () => {
    const actor = createUi();
    prepare(actor);
    actor.send({ type: "PERP_ORDER_CANCELLED" });
    expect(actor.getSnapshot().value).toBe("form");
    expect(actor.getSnapshot().context.clientOrderId).toBeNull();
    expect(actor.getSnapshot().context.draft).toEqual(DRAFT);
  });

  it("affiche un refus serveur fermé et conserve le brouillon", () => {
    const actor = createUi();
    prepare(actor);
    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    actor.send({
      type: "SUBMISSION_SUCCEEDED",
      result: { status: "REFUSED", reasonCode: "PERP_DAILY_LOSS_BREACHED" },
    });
    expect(actor.getSnapshot().value).toBe("result");
    actor.send({ type: "SUBMISSION_DISMISSED" });
    expect(actor.getSnapshot().value).toBe("form");
    expect(actor.getSnapshot().context.draft).toEqual(DRAFT);
    expect(actor.getSnapshot().context.result).toBeNull();
  });

  it("affiche une erreur transport retryable", () => {
    const actor = createUi();
    prepare(actor);
    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    actor.send({
      type: "SUBMISSION_FAILED",
      error: { code: "REQUEST_FAILED", retryable: true },
    });
    expect(actor.getSnapshot().value).toBe("result");
    expect(actor.getSnapshot().context.lastError?.retryable).toBe(true);
  });

  it("purge tout via le reset global", () => {
    const actor = createUi();
    prepare(actor);
    actor.send({
      type: "PERP_ORDER_CONFIRMED",
      permissions,
      clientOrderId: "perp-abc12345",
    });
    actor.send({ type: "PERP_ORDER_FORM_RESET" });
    expect(actor.getSnapshot().value).toBe("form");
    expect(actor.getSnapshot().context).toEqual({
      draft: null,
      clientOrderId: null,
      result: null,
      lastRefusal: null,
      lastError: null,
    });
  });
});
