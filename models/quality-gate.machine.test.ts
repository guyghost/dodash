import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import { qualityGateMachine } from "./quality-gate.machine.js";
import type {
  QualityGateEvent,
  QualityGateSource,
} from "./quality-gate.types.js";

const createQualityGate = () => createActor(qualityGateMachine).start();
type QualityGateActor = ReturnType<typeof createQualityGate>;

const advanceTo = (
  actor: QualityGateActor,
  target:
    | "validatingEnvironment"
    | "auditingDependencies"
    | "scanningSecrets"
    | "checking"
    | "testing"
    | "building"
    | "testingArtifact",
  source: QualityGateSource = "pre-push",
) => {
  actor.send({ type: "GATE_REQUESTED", source });
  if (target === "validatingEnvironment") return;

  actor.send({ type: "ENVIRONMENT_VALIDATED" });
  if (source === "pre-commit") return;
  if (target === "auditingDependencies") return;

  actor.send({ type: "DEPENDENCY_AUDIT_PASSED" });
  if (target === "scanningSecrets") return;

  actor.send({ type: "SECRET_SCAN_PASSED" });
  if (target === "checking") return;

  actor.send({ type: "CHECK_PASSED" });
  if (target === "testing") return;

  actor.send({ type: "TESTS_PASSED" });
  if (target === "building") return;

  actor.send({ type: "BUILD_PASSED" });
};

describe("qualityGateMachine", () => {
  it("termine un pre-commit après le check statique", () => {
    const actor = createQualityGate();
    advanceTo(actor, "checking", "pre-commit");

    actor.send({ type: "TESTS_PASSED" });
    expect(actor.getSnapshot().value).toBe("checking");

    actor.send({ type: "CHECK_PASSED" });
    expect(actor.getSnapshot().value).toBe("passed");
    expect(actor.getSnapshot().status).toBe("done");
  });

  it.each(["pre-push", "ci"] as const)(
    "refuse de vérifier le code avant les deux portes sécurité pour %s",
    (source) => {
      const actor = createQualityGate();
      advanceTo(actor, "auditingDependencies", source);

      actor.send({ type: "CHECK_PASSED" });
      expect(actor.getSnapshot().value).toBe("auditingDependencies");
      actor.send({ type: "DEPENDENCY_AUDIT_PASSED" });
      expect(actor.getSnapshot().value).toBe("scanningSecrets");
      actor.send({ type: "SECRET_SCAN_PASSED" });
      expect(actor.getSnapshot().value).toBe("checking");
    },
  );

  it.each(["pre-push", "ci"] as const)(
    "termine le gate complet pour %s",
    (source) => {
      const actor = createQualityGate();
      advanceTo(actor, "testingArtifact", source);
      actor.send({ type: "ARTIFACT_TESTS_PASSED" });

      expect(actor.getSnapshot().value).toBe("passed");
      expect(actor.getSnapshot().context.source).toBe(source);
    },
  );

  const failures: ReadonlyArray<{
    state:
      | "validatingEnvironment"
      | "auditingDependencies"
      | "scanningSecrets"
      | "checking"
      | "testing"
      | "building"
      | "testingArtifact";
    event: QualityGateEvent;
    errorCode: string;
  }> = [
    {
      state: "validatingEnvironment",
      event: { type: "ENVIRONMENT_FAILED" },
      errorCode: "ENVIRONMENT_INVALID",
    },
    {
      state: "auditingDependencies",
      event: { type: "DEPENDENCY_AUDIT_FAILED" },
      errorCode: "DEPENDENCY_AUDIT_FAILED",
    },
    {
      state: "scanningSecrets",
      event: { type: "SECRET_SCAN_FAILED" },
      errorCode: "SECRET_SCAN_FAILED",
    },
    {
      state: "checking",
      event: { type: "CHECK_FAILED" },
      errorCode: "CHECK_FAILED",
    },
    {
      state: "testing",
      event: { type: "TESTS_FAILED" },
      errorCode: "TEST_FAILED",
    },
    {
      state: "building",
      event: { type: "BUILD_FAILED" },
      errorCode: "BUILD_FAILED",
    },
    {
      state: "testingArtifact",
      event: { type: "ARTIFACT_TESTS_FAILED" },
      errorCode: "ARTIFACT_TEST_FAILED",
    },
  ];

  it.each(failures)(
    "bloque le workflow après $errorCode",
    ({ state, event, errorCode }) => {
      const actor = createQualityGate();
      advanceTo(actor, state);
      actor.send(event);

      expect(actor.getSnapshot().value).toBe("failed");
      expect(actor.getSnapshot().context.lastError?.code).toBe(errorCode);
    },
  );

  it.each([
    "validatingEnvironment",
    "auditingDependencies",
    "scanningSecrets",
    "checking",
    "testing",
    "building",
    "testingArtifact",
  ] as const)("annule explicitement depuis %s", (state) => {
    const actor = createQualityGate();
    advanceTo(actor, state);
    actor.send({ type: "CANCEL_REQUESTED" });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("ne retry qu’après une demande explicite", () => {
    const actor = createQualityGate();
    advanceTo(actor, "checking");
    actor.send({ type: "CHECK_FAILED" });

    actor.send({ type: "ENVIRONMENT_VALIDATED" });
    expect(actor.getSnapshot().value).toBe("failed");

    actor.send({ type: "RETRY_REQUESTED" });
    expect(actor.getSnapshot().value).toBe("validatingEnvironment");
    expect(actor.getSnapshot().context.lastError).toBeNull();
  });
});
