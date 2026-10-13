import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { marketSourceProbeMachine } from "./market-source-probe.machine.js";

describe("market source probe", () => {
  const input = { enabled: true, startedAt: 100, expiresAt: 1_000, requestCount: 15 };
  it("closes inactive/expired windows without running effects", () => {
    for (const overrides of [{ enabled: false }, { expiresAt: 100 }, { expiresAt: 86_400_101 }]) {
      const actor = createActor(marketSourceProbeMachine, { input: { ...input, ...overrides } }).start();
      actor.send({ type: "START", now: 100 });
      expect(actor.getSnapshot().value).toBe("inactive");
      actor.stop();
    }
  });
  it("blocks a rate-limited provider and completes after bounded observations", () => {
    const actor = createActor(marketSourceProbeMachine, { input }).start();
    actor.send({ type: "START", now: 100 });
    actor.send({ type: "RESULT", provider: "coinbase-advanced", status: 429 });
    expect(actor.getSnapshot().context.blockedProviders).toEqual(["coinbase-advanced"]);
    for (let i = 1; i < 15; i++) actor.send({ type: "RESULT", provider: "coinbase-exchange", status: 200 });
    expect(actor.getSnapshot().value).toBe("completed");
    expect(actor.getSnapshot().context.completed).toBe(15);
    actor.stop();
  });
  it("expires a running batch without accepting further results", () => {
    const actor = createActor(marketSourceProbeMachine, { input }).start();
    actor.send({ type: "START", now: 100 });
    actor.send({ type: "EXPIRE" });
    actor.send({ type: "RESULT", provider: "hyperliquid", status: 200 });
    expect(actor.getSnapshot().value).toBe("inactive");
    expect(actor.getSnapshot().context.completed).toBe(0);
    actor.stop();
  });
});
