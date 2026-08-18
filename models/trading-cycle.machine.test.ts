import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { tradingCycleMachine } from "./trading-cycle.machine.js";
import type { TradingCycleEvent, WorkflowError } from "./trading-cycle.types.js";

const permission = { canControl: true, canTrade: true } as const;

const error = (
  phase: WorkflowError["phase"],
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase, code, retryable });

const createTradingActor = () =>
  createActor(tradingCycleMachine, {
    input: { agentId: "btc-rsi", strategyIds: ["rsi-reversion"] },
  }).start();

const send = (
  actor: ReturnType<typeof createTradingActor>,
  ...events: TradingCycleEvent[]
) => events.forEach((event) => actor.send(event));

const reachRisk = (actor: ReturnType<typeof createTradingActor>) => {
  send(
    actor,
    { type: "START_REQUESTED", permissions: permission },
    { type: "SCHEDULE_SUCCEEDED", nextWakeAt: 2_000 },
    { type: "ALARM_FIRED", cycleId: "cycle-1", triggeredAt: 10_000 },
    {
      type: "MARKET_DATA_READY",
      snapshotId: "market-1",
      candleClosedAt: 9_500,
    },
    { type: "INDICATORS_COMPUTED", indicatorsId: "indicators-1" },
    { type: "STRATEGIES_EVALUATED", signalsId: "signals-1" },
    {
      type: "ALLOCATION_COMPLETED",
      decisionId: "decision-1",
      orderCount: 1,
    },
  );
  expect(actor.getSnapshot().value).toBe("checkingRisk");
};

describe("tradingCycleMachine", () => {
  it("refuse un démarrage sans les deux permissions", () => {
    const actor = createTradingActor();

    actor.send({
      type: "START_REQUESTED",
      permissions: { canControl: true, canTrade: false },
    });

    expect(actor.getSnapshot().value).toBe("stopped");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "TRADE_PERMISSION_REQUIRED",
    );
  });

  it("termine un cycle sans ordre et reprogramme le suivant", () => {
    const actor = createTradingActor();
    reachRisk(actor);

    send(actor, { type: "RISK_REJECTED" }, { type: "PERSIST_SUCCEEDED" });

    expect(actor.getSnapshot().value).toBe("scheduling");
    expect(actor.getSnapshot().context.outcome).toBe("RISK_REJECTED");
    expect(actor.getSnapshot().context.clientOrderId).toBeNull();
  });

  it("ignore une alarme dupliquée", () => {
    const actor = createTradingActor();
    send(
      actor,
      { type: "START_REQUESTED", permissions: permission },
      { type: "SCHEDULE_SUCCEEDED", nextWakeAt: 2_000 },
      { type: "ALARM_FIRED", cycleId: "cycle-1", triggeredAt: 10_000 },
      {
        type: "MARKET_DATA_READY",
        snapshotId: "market-1",
        candleClosedAt: 9_500,
      },
      { type: "INDICATORS_COMPUTED", indicatorsId: "indicators-1" },
      { type: "STRATEGIES_EVALUATED", signalsId: "signals-1" },
      {
        type: "ALLOCATION_COMPLETED",
        decisionId: "decision-1",
        orderCount: 0,
      },
      { type: "PERSIST_SUCCEEDED" },
      { type: "SCHEDULE_SUCCEEDED", nextWakeAt: 20_000 },
      { type: "ALARM_FIRED", cycleId: "cycle-1", triggeredAt: 20_000 },
    );

    expect(actor.getSnapshot().value).toBe("waiting");
    expect(actor.getSnapshot().context.lastError?.code).toBe("DUPLICATE_ALARM");
  });

  it("rejette les données périmées avant tout calcul", () => {
    const actor = createTradingActor();
    send(
      actor,
      { type: "START_REQUESTED", permissions: permission },
      { type: "SCHEDULE_SUCCEEDED", nextWakeAt: 2_000 },
      { type: "ALARM_FIRED", cycleId: "cycle-1", triggeredAt: 200_000 },
      {
        type: "MARKET_DATA_READY",
        snapshotId: "stale-market",
        candleClosedAt: 1,
      },
    );

    expect(actor.getSnapshot().value).toBe("retryingMarketData");
    expect(actor.getSnapshot().context.marketSnapshotId).toBeNull();
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "STALE_MARKET_DATA",
    );
  });

  it("persiste l’intention avant d’autoriser la soumission", () => {
    const actor = createTradingActor();
    reachRisk(actor);

    actor.send({ type: "RISK_APPROVED" });
    expect(actor.getSnapshot().value).toBe("persistingOrderIntent");

    actor.send({
      type: "AUTHORIZATION_READY",
      issuedAt: 10_000,
      expiresAt: 130_000,
    });
    expect(actor.getSnapshot().value).toBe("persistingOrderIntent");

    actor.send({
      type: "ORDER_INTENT_PERSISTED",
      clientOrderId: "btc-rsi:cycle-1:0",
    });
    expect(actor.getSnapshot().value).toBe("authorizing");
  });

  it("réconcilie une issue inconnue et s’arrête seulement après persistance", () => {
    const actor = createTradingActor();
    reachRisk(actor);
    send(
      actor,
      { type: "RISK_APPROVED" },
      {
        type: "ORDER_INTENT_PERSISTED",
        clientOrderId: "btc-rsi:cycle-1:0",
      },
      { type: "AUTHORIZATION_READY", issuedAt: 10_000, expiresAt: 130_000 },
      {
        type: "ORDER_OUTCOME_UNKNOWN",
        error: error("execution", "ORDER_OUTCOME_UNKNOWN", true),
      },
      { type: "STOP_REQUESTED" },
    );

    expect(actor.getSnapshot().value).toBe("reconcilingOrder");

    send(
      actor,
      { type: "ORDER_RECONCILED", exchangeOrderId: "order-42" },
      { type: "PERSIST_SUCCEEDED" },
    );

    expect(actor.getSnapshot().value).toBe("stopped");
    expect(actor.getSnapshot().context.outcome).toBe("ORDER_CONFIRMED");
  });

  it("borne la régénération d’une autorisation invalide", () => {
    const actor = createTradingActor();
    reachRisk(actor);
    send(
      actor,
      { type: "RISK_APPROVED" },
      {
        type: "ORDER_INTENT_PERSISTED",
        clientOrderId: "btc-rsi:cycle-1:0",
      },
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      send(
        actor,
        { type: "AUTHORIZATION_READY", issuedAt: 10_000, expiresAt: 9_000 },
        { type: "RETRY_TIMER_ELAPSED" },
      );
    }
    actor.send({
      type: "AUTHORIZATION_READY",
      issuedAt: 10_000,
      expiresAt: 9_000,
    });

    expect(actor.getSnapshot().value).toBe("persisting");
    expect(actor.getSnapshot().context.outcome).toBe("FAILED");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "AUTHORIZATION_EXPIRED",
    );
  });

  it("fait passer le kill switch par annulation, persistance puis halted", () => {
    const actor = createTradingActor();
    send(
      actor,
      { type: "START_REQUESTED", permissions: permission },
      { type: "SCHEDULE_SUCCEEDED", nextWakeAt: 2_000 },
      { type: "KILL_SWITCH_ENGAGED" },
    );

    expect(actor.getSnapshot().value).toBe("cancelling");

    send(actor, { type: "EFFECT_CANCELLED" }, { type: "PERSIST_SUCCEEDED" });

    expect(actor.getSnapshot().value).toBe("halted");
    expect(actor.getSnapshot().context.outcome).toBe("CANCELLED");
  });

  it("ne reprogramme jamais tant que la persistance échoue", () => {
    const actor = createTradingActor();
    reachRisk(actor);
    actor.send({ type: "RISK_REJECTED" });

    actor.send({
      type: "PERSIST_FAILED",
      error: error("persistence", "PERSISTENCE_FAILURE", true),
    });

    expect(actor.getSnapshot().value).toBe("retryingPersistence");
    expect(actor.getSnapshot().context.attempts.persistence).toBe(1);
  });
});
