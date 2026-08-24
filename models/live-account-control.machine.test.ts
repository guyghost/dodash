import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { liveAccountControlMachine } from "./live-account-control.machine.js";
import type { WorkflowError } from "./trading-cycle.types.js";

const permissions = { canControl: true, canTrade: true } as const;
const failure = (
  phase: WorkflowError["phase"],
  retryable = true,
): WorkflowError => ({ phase, code: "RECONCILIATION_FAILURE", retryable });

const actorForKill = () => {
  const actor = createActor(liveAccountControlMachine, { input: {} }).start();
  actor.send({
    type: "KILL_REQUESTED",
    productId: "BTC-USD",
    flattenClientOrderPrefix: "kill:btc:cycle-1",
    permissions,
  });
  return actor;
};

const account = (
  totalBaseQuantity: number,
  availableBaseQuantity: number,
  openOrderCount = 0,
) => ({
  type: "ACCOUNT_RECONCILED" as const,
  snapshotId: crypto.randomUUID(),
  totalBaseQuantity,
  availableBaseQuantity,
  dustQuantity: 0.000_000_01,
  openOrderCount,
});

describe("liveAccountControlMachine", () => {
  it("completes an already-flat kill only after orders are cleared", () => {
    const actor = actorForKill();
    expect(actor.getSnapshot().value).toBe("cancellingOrders");

    actor.send({ type: "ORDERS_CLEARED" });
    expect(actor.getSnapshot().value).toBe("reconcilingPosition");
    actor.send(account(0, 0));

    expect(actor.getSnapshot().value).toBe("completed");
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("flattens only the reconciled available quantity then verifies flat", () => {
    const actor = actorForKill();
    actor.send({ type: "ORDERS_CLEARED" });
    actor.send(account(0.25, 0.25));

    expect(actor.getSnapshot().value).toBe("flatteningPosition");
    expect(actor.getSnapshot().context.flattenQuantity).toBe(0.25);
    expect(actor.getSnapshot().context.attempts.flatten).toBe(1);

    actor.send({ type: "FLATTEN_CONFIRMED" });
    expect(actor.getSnapshot().value).toBe("verifyingFlat");
    actor.send(account(0, 0));
    expect(actor.getSnapshot().value).toBe("completed");
  });

  it("fails closed after reconciling a residual unknown flatten outcome", () => {
    const actor = actorForKill();
    actor.send({ type: "ORDERS_CLEARED" });
    actor.send(account(0.25, 0.25));
    actor.send({ type: "FLATTEN_OUTCOME_UNKNOWN" });

    expect(actor.getSnapshot().value).toBe("verifyingFlat");
    actor.send(account(0.05, 0.05));
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "ORDER_OUTCOME_UNKNOWN",
    );
    expect(actor.getSnapshot().context.attempts.flatten).toBe(1);
  });

  it("allows a second reconciled residual only after a confirmed terminal fill", () => {
    const actor = actorForKill();
    actor.send({ type: "ORDERS_CLEARED" });
    actor.send(account(0.25, 0.25));
    actor.send({ type: "FLATTEN_CONFIRMED" });
    actor.send(account(0.05, 0.05));

    expect(actor.getSnapshot().value).toBe("flatteningPosition");
    expect(actor.getSnapshot().context.flattenQuantity).toBe(0.05);
    expect(actor.getSnapshot().context.attempts.flatten).toBe(2);
  });

  it("returns to cancellation when reconciliation observes an open order", () => {
    const actor = actorForKill();
    actor.send({ type: "ORDERS_CLEARED" });
    actor.send(account(0.25, 0.25, 1));

    expect(actor.getSnapshot().value).toBe("cancellingOrders");
  });

  it("retries held quantity boundedly and then fails closed", () => {
    const actor = createActor(liveAccountControlMachine, {
      input: { retryLimits: { reconciliation: 1 } },
    }).start();
    actor.send({
      type: "KILL_REQUESTED",
      productId: "BTC-USD",
      flattenClientOrderPrefix: "kill:btc:cycle-1",
      permissions,
    });
    actor.send({ type: "ORDERS_CLEARED" });
    actor.send(account(0.25, 0.1));
    expect(actor.getSnapshot().value).toBe("retryingReconciliation");

    actor.send({ type: "RETRY_TIMER_ELAPSED" });
    actor.send(account(0.25, 0.1));
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "RECONCILIATION_FAILURE",
    );
  });

  it("retries adapter failures only within the phase budget", () => {
    const actor = createActor(liveAccountControlMachine, {
      input: { retryLimits: { cancellation: 1 } },
    }).start();
    actor.send({
      type: "KILL_REQUESTED",
      productId: "BTC-USD",
      flattenClientOrderPrefix: "kill:btc:cycle-1",
      permissions,
    });
    actor.send({ type: "OPERATION_FAILED", error: failure("cancellation") });
    expect(actor.getSnapshot().value).toBe("retryingCancellation");
    actor.send({ type: "RETRY_TIMER_ELAPSED" });
    actor.send({ type: "OPERATION_FAILED", error: failure("cancellation") });
    expect(actor.getSnapshot().value).toBe("failed");
  });

  it("rejects missing control permission and invalid account facts", () => {
    const denied = createActor(liveAccountControlMachine, {
      input: {},
    }).start();
    denied.send({
      type: "KILL_REQUESTED",
      productId: "BTC-USD",
      flattenClientOrderPrefix: "kill:btc:cycle-1",
      permissions: { canControl: false, canTrade: true },
    });
    expect(denied.getSnapshot().value).toBe("failed");
    expect(denied.getSnapshot().context.lastError?.code).toBe(
      "CONTROL_PERMISSION_REQUIRED",
    );

    const invalid = actorForKill();
    invalid.send({ type: "ORDERS_CLEARED" });
    invalid.send(account(-1, 0));
    expect(invalid.getSnapshot().value).toBe("failed");
  });

  it("ignores a flatten confirmation before a flatten is prepared", () => {
    const actor = actorForKill();
    actor.send({ type: "FLATTEN_CONFIRMED" });
    expect(actor.getSnapshot().value).toBe("cancellingOrders");
    expect(actor.getSnapshot().context.attempts.flatten).toBe(0);
  });
});
