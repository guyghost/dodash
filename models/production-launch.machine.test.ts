import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { productionLaunchMachine } from "./production-launch.machine.js";
import { validProductionLaunchEvidence as fixtures } from "./production-launch.test.js";

const createLaunch = () =>
  createActor(productionLaunchMachine, { input: fixtures.scope }).start();

const submitResearch = (actor: ReturnType<typeof createLaunch>) => {
  actor.send({ type: "LAUNCH_REQUESTED" });
  actor.send({
    type: "RESEARCH_EVIDENCE_SUBMITTED",
    evidence: fixtures.researchEvidence(),
  });
};

describe("productionLaunchMachine", () => {
  it("n'approuve qu'après les cinq portes dans l'ordre", () => {
    const actor = createLaunch();
    submitResearch(actor);
    expect(actor.getSnapshot().value).toBe("assessingRisk");

    actor.send({
      type: "RISK_EVIDENCE_SUBMITTED",
      evidence: fixtures.riskEvidence(),
    });
    actor.send({
      type: "ENGINEERING_EVIDENCE_SUBMITTED",
      evidence: fixtures.engineeringEvidence(),
    });
    actor.send({
      type: "OPERATIONS_EVIDENCE_SUBMITTED",
      evidence: fixtures.operationsEvidence(),
    });
    actor.send({
      type: "CANARY_EVIDENCE_SUBMITTED",
      evidence: fixtures.canaryEvidence(),
    });

    expect(actor.getSnapshot().value).toBe("approved");
    expect(actor.getSnapshot().status).toBe("done");
    expect(actor.getSnapshot().context.passedStages).toEqual([
      "research",
      "risk",
      "engineering",
      "operations",
      "canary",
    ]);
  });

  it("ignore une preuve soumise hors séquence", () => {
    const actor = createLaunch();
    actor.send({
      type: "ENGINEERING_EVIDENCE_SUBMITTED",
      evidence: fixtures.engineeringEvidence(),
    });
    expect(actor.getSnapshot().value).toBe("idle");

    actor.send({ type: "LAUNCH_REQUESTED" });
    actor.send({
      type: "RISK_EVIDENCE_SUBMITTED",
      evidence: fixtures.riskEvidence(),
    });
    expect(actor.getSnapshot().value).toBe("assessingResearch");
  });

  it("rejette au premier échec et conserve le motif fermé", () => {
    const actor = createLaunch();
    submitResearch(actor);
    actor.send({
      type: "RISK_EVIDENCE_SUBMITTED",
      evidence: {
        ...fixtures.riskEvidence(),
        killFlattensManagedPosition: false,
      },
    });

    expect(actor.getSnapshot().value).toBe("rejected");
    expect(actor.getSnapshot().context.failedStage).toBe("risk");
    expect(actor.getSnapshot().context.reasonCode).toBe(
      "RISK_KILL_NOT_FLATTENING",
    );
    expect(actor.getSnapshot().context.passedStages).toEqual(["research"]);
  });

  it("recommence à la recherche et efface les preuves après retry", () => {
    const actor = createLaunch();
    actor.send({ type: "LAUNCH_REQUESTED" });
    actor.send({
      type: "RESEARCH_EVIDENCE_SUBMITTED",
      evidence: { ...fixtures.researchEvidence(), verdict: "DECLASSIFIED" },
    });
    expect(actor.getSnapshot().value).toBe("rejected");

    actor.send({ type: "RETRY_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("assessingResearch");
    expect(actor.getSnapshot().context.failedStage).toBeNull();
    expect(actor.getSnapshot().context.reasonCode).toBeNull();
    expect(actor.getSnapshot().context.passedStages).toEqual([]);
  });

  it("reset un rejet vers idle", () => {
    const actor = createLaunch();
    actor.send({ type: "LAUNCH_REQUESTED" });
    actor.send({
      type: "RESEARCH_EVIDENCE_SUBMITTED",
      evidence: { ...fixtures.researchEvidence(), verdict: "RESEARCH_ONLY" },
    });
    actor.send({ type: "RESET" });

    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.passedStages).toEqual([]);
  });

  it.each([
    "assessingResearch",
    "assessingRisk",
    "assessingEngineering",
    "assessingOperations",
    "assessingCanary",
  ] as const)("annule explicitement depuis %s", (target) => {
    const actor = createLaunch();
    actor.send({ type: "LAUNCH_REQUESTED" });
    if (target !== "assessingResearch") {
      actor.send({
        type: "RESEARCH_EVIDENCE_SUBMITTED",
        evidence: fixtures.researchEvidence(),
      });
    }
    if (["assessingEngineering", "assessingOperations", "assessingCanary"].includes(target)) {
      actor.send({
        type: "RISK_EVIDENCE_SUBMITTED",
        evidence: fixtures.riskEvidence(),
      });
    }
    if (["assessingOperations", "assessingCanary"].includes(target)) {
      actor.send({
        type: "ENGINEERING_EVIDENCE_SUBMITTED",
        evidence: fixtures.engineeringEvidence(),
      });
    }
    if (target === "assessingCanary") {
      actor.send({
        type: "OPERATIONS_EVIDENCE_SUBMITTED",
        evidence: fixtures.operationsEvidence(),
      });
    }

    expect(actor.getSnapshot().value).toBe(target);
    actor.send({ type: "CANCEL_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().status).toBe("done");
  });
});
