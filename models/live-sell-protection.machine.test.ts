import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { liveSellProtectionMachine } from "./live-sell-protection.machine.js";

const permission = { canControl: true, canTrade: true };
const failure = {
  phase: "reconciliation" as const,
  code: "RECONCILIATION_FAILURE" as const,
  retryable: true,
};

const start = () => {
  const actor = createActor(liveSellProtectionMachine, { input: {} }).start();
  actor.send({
    type: "SELL_REQUESTED",
    productId: "GRT-USD",
    clientOrderId: "sell-1",
    quantity: 10,
    permissions: permission,
  });
  actor.send({ type: "PROTECTIONS_CLEARED" });
  return actor;
};

const account = (quantity: number) => ({
  type: "ACCOUNT_RECONCILED" as const,
  snapshotId: `account-${quantity}`,
  totalBaseQuantity: quantity,
  availableBaseQuantity: quantity,
  averageEntryPrice: quantity === 0 ? 0 : 0.2,
  dustQuantity: 0.01,
});

describe("liveSellProtectionMachine", () => {
  it("termine sans vente si la protection a déjà aplati la position", () => {
    const actor = start();
    actor.send(account(0));
    expect(actor.getSnapshot().value).toBe("completed");
    expect(actor.getSnapshot().context.outcome).toBe("NO_SELL_NEEDED");
  });

  it("vend puis confirme une protection unique sur le reliquat", () => {
    const actor = start();
    actor.send(account(20));
    expect(actor.getSnapshot().value).toBe("submittingSell");
    actor.send({ type: "SELL_ACKNOWLEDGED", exchangeOrderId: "sell-order-1" });
    actor.send({ type: "SELL_CONFIRMED", exchangeOrderId: "sell-order-1" });
    actor.send(account(10));
    expect(actor.getSnapshot().value).toBe("armingResidual");
    actor.send({
      type: "PROTECTION_ACKNOWLEDGED",
      protectiveOrderId: "protection-2",
    });
    actor.send({ type: "PROTECTION_CONFIRMED" });
    expect(actor.getSnapshot().value).toBe("completed");
    expect(actor.getSnapshot().context.outcome).toBe("SOLD_REPROTECTED");
  });

  it("aplatit en sécurité si la position change pendant l'annulation", () => {
    const actor = start();
    actor.send(account(5));
    expect(actor.getSnapshot().value).toBe("safetyFlattening");
    actor.send({ type: "SAFETY_FLATTEN_SUCCEEDED" });
    expect(actor.getSnapshot().value).toBe("safetyCompleted");
    expect(actor.getSnapshot().context.outcome).toBe("FLATTENED_AFTER_FAILURE");
  });

  it("aplatit si le reliquat ne peut pas être protégé", () => {
    const actor = start();
    actor.send(account(20));
    actor.send({ type: "SELL_OUTCOME_UNKNOWN", exchangeOrderId: "sell-order-1" });
    actor.send({ type: "SELL_CONFIRMED", exchangeOrderId: "sell-order-1" });
    actor.send(account(10));
    actor.send({ type: "OPERATION_FAILED", error: failure });
    expect(actor.getSnapshot().value).toBe("safetyFlattening");
  });

  it("reste failed si l'aplatissement de sécurité échoue", () => {
    const actor = start();
    actor.send({ type: "OPERATION_FAILED", error: failure });
    actor.send({ type: "SAFETY_FLATTEN_FAILED", error: failure });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.outcome).toBe("FAILED");
  });
});
