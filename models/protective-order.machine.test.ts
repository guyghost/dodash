import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { protectiveOrderMachine } from "./protective-order.machine.js";
import {
  createProtectiveOrderPlan,
  resolveProtectiveOpen,
  resolveProtectiveRange,
} from "./protective-order.js";

const fixedPolicy = {
  mode: "FIXED_BPS",
  stopLossBps: 100,
  takeProfitBps: 200,
} as const;

const armEvent = {
  type: "ARM_REQUESTED",
  positionId: "position-1",
  quantity: 2,
  averageEntryPrice: 100,
  atr: 2,
  armedAt: 1_000,
} as const;

describe("protective order core", () => {
  it("dérive les seuils fixes depuis le prix de revient", () => {
    const result = createProtectiveOrderPlan({
      ...armEvent,
      policy: fixedPolicy,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        positionId: "position-1",
        quantity: 2,
        averageEntryPrice: 100,
        stopPrice: 99,
        takeProfitPrice: 102,
        armedAt: 1_000,
        policyMode: "FIXED_BPS",
      },
    });
  });

  it("dérive les seuils ATR sans regarder la bougie d’exécution", () => {
    const result = createProtectiveOrderPlan({
      ...armEvent,
      policy: {
        mode: "ATR_MULTIPLE",
        stopAtrMultiple: 1.5,
        takeAtrMultiple: 3,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stopPrice).toBe(97);
    expect(result.value.takeProfitPrice).toBe(106);
  });

  it("résout un gap stop au prix d’ouverture", () => {
    const plan = createProtectiveOrderPlan({ ...armEvent, policy: fixedPolicy });
    if (!plan.ok) throw new Error("invalid fixture");

    const resolution = resolveProtectiveOpen(plan.value, {
      start: 2_000,
      open: 95,
    });

    expect(resolution).toEqual({
      ok: true,
      value: {
        status: "TRIGGERED",
        kind: "STOP_LOSS",
        reason: "GAP_OPEN",
        referencePrice: 95,
        triggeredAt: 2_000,
      },
    });
  });

  it("résout un gap objectif au meilleur prix d’ouverture", () => {
    const plan = createProtectiveOrderPlan({ ...armEvent, policy: fixedPolicy });
    if (!plan.ok) throw new Error("invalid fixture");

    const resolution = resolveProtectiveOpen(plan.value, {
      start: 2_000,
      open: 105,
    });

    expect(resolution.ok && resolution.value).toMatchObject({
      status: "TRIGGERED",
      kind: "TAKE_PROFIT",
      reason: "GAP_OPEN",
      referencePrice: 105,
    });
  });

  it("choisit le stop lorsque les deux seuils sont touchés", () => {
    const plan = createProtectiveOrderPlan({ ...armEvent, policy: fixedPolicy });
    if (!plan.ok) throw new Error("invalid fixture");

    const resolution = resolveProtectiveRange(plan.value, {
      start: 2_000,
      high: 103,
      low: 98,
    });

    expect(resolution.ok && resolution.value).toMatchObject({
      status: "TRIGGERED",
      kind: "STOP_LOSS",
      reason: "AMBIGUOUS_STOP_FIRST",
      referencePrice: 99,
    });
  });
});

describe("protectiveOrderMachine", () => {
  it("impose la séquence open puis range et termine au trigger", () => {
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: fixedPolicy },
    }).start();

    actor.send(armEvent);
    expect(actor.getSnapshot().matches({ armed: "awaitingOpen" })).toBe(true);
    actor.send({ type: "CANDLE_OPENED", start: 2_000, open: 100 });
    expect(actor.getSnapshot().matches({ armed: "awaitingRange" })).toBe(true);
    actor.send({ type: "CANDLE_RANGE_REPLAYED", start: 2_000, high: 103, low: 98 });

    expect(actor.getSnapshot().value).toBe("triggered");
    expect(actor.getSnapshot().context.resolution?.kind).toBe("STOP_LOSS");
  });

  it("réarme après ajout mais conserve les seuils après réduction", () => {
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: fixedPolicy },
    }).start();
    actor.send(armEvent);
    actor.send({ type: "CANDLE_OPENED", start: 2_000, open: 100 });
    actor.send({
      type: "POSITION_INCREASED",
      quantity: 3,
      averageEntryPrice: 110,
      atr: 4,
      updatedAt: 2_000,
    });
    expect(actor.getSnapshot().context.plan?.stopPrice).toBe(108.9);
    actor.send({ type: "POSITION_REDUCED", quantity: 1, updatedAt: 2_000 });

    expect(actor.getSnapshot().context.plan).toMatchObject({
      quantity: 1,
      stopPrice: 108.9,
      takeProfitPrice: 112.2,
    });
  });

  it("échoue si la plage arrive avant l’ouverture", () => {
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: fixedPolicy },
    }).start();
    actor.send(armEvent);
    actor.send({ type: "CANDLE_RANGE_REPLAYED", start: 2_000, high: 101, low: 99 });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "INVALID_PROTECTIVE_SEQUENCE",
    );
  });

  it("annule explicitement un bracket armé", () => {
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: fixedPolicy },
    }).start();
    actor.send(armEvent);
    actor.send({ type: "CANCEL_REQUESTED", reason: "POSITION_CLOSED" });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().context.cancelReason).toBe("POSITION_CLOSED");
  });
});
