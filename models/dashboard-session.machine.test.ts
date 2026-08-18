import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { dashboardSessionMachine } from "./dashboard-session.machine.js";

const createDashboard = () =>
  createActor(dashboardSessionMachine, {
    input: { defaultAgentName: "btc-usd--rsi" },
  }).start();

const connect = (actor: ReturnType<typeof createDashboard>) => {
  actor.send({
    type: "CONNECT_REQUESTED",
    agentName: "btc-usd--rsi",
    credentialPresent: true,
  });
  actor.send({
    type: "STATE_LOADED",
    remotePhase: "waiting",
    remoteUpdatedAt: 1_700_000_000_000,
  });
};

describe("dashboardSessionMachine", () => {
  it("refuse une connexion sans cible ou sans credential", () => {
    const actor = createDashboard();
    actor.send({
      type: "CONNECT_REQUESTED",
      agentName: "",
      credentialPresent: true,
    });
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.lastError?.code).toBe("INVALID_TARGET");

    actor.send({
      type: "CONNECT_REQUESTED",
      agentName: "btc-usd--rsi",
      credentialPresent: false,
    });
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "INVALID_CREDENTIAL",
    );
  });

  it("charge puis rafraîchit un état distant validé", () => {
    const actor = createDashboard();
    connect(actor);
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.remotePhase).toBe("waiting");

    actor.send({ type: "REFRESH_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("refreshing");
    actor.send({
      type: "STATE_LOADED",
      remotePhase: "checkingRisk",
      remoteUpdatedAt: 1_700_000_005_000,
    });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.remotePhase).toBe("checkingRisk");
  });

  it("refuse une commande de trading sans permission", () => {
    const actor = createDashboard();
    connect(actor);
    actor.send({
      type: "COMMAND_REQUESTED",
      command: "start",
      permissions: { canControl: true, canTrade: false },
    });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.lastError?.code).toBe(
      "TRADE_PERMISSION_REQUIRED",
    );
  });

  it("exige une confirmation distincte avant le kill switch", () => {
    const actor = createDashboard();
    connect(actor);
    actor.send({
      type: "KILL_CONFIRMATION_REQUESTED",
      permissions: { canControl: true, canTrade: true },
    });
    expect(actor.getSnapshot().value).toBe("confirmingKill");
    expect(actor.getSnapshot().context.pendingCommand).toBeNull();

    actor.send({
      type: "KILL_CONFIRMED",
      permissions: { canControl: true, canTrade: true },
    });
    expect(actor.getSnapshot().value).toBe("commanding");
    expect(actor.getSnapshot().context.pendingCommand).toBe("kill");
  });

  it("n’applique jamais une commande optimistement", () => {
    const actor = createDashboard();
    connect(actor);
    actor.send({
      type: "COMMAND_REQUESTED",
      command: "stop",
      permissions: { canControl: true, canTrade: true },
    });
    expect(actor.getSnapshot().context.remotePhase).toBe("waiting");
    actor.send({
      type: "REQUEST_FAILED",
      error: { code: "REQUEST_FAILED", retryable: true },
    });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.remotePhase).toBe("waiting");
  });
});
