import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { assessP7ExecutionRobustness, P7_EXECUTION_SCENARIOS, p7ExecutionRobustnessMachine } from "./p7-execution-robustness.js";

const results = () => P7_EXECUTION_SCENARIOS.map((scenario) => ({
  id: scenario.id, netReturn: 2, cagr: 0.52, maxDrawdown: 0.456,
  windowDrawdowns: [0.3, 0.3, 0.3, 0.3, 0.3],
}));

describe("frozen P7 robustness assessment", () => {
  it("requires all six scenarios and finite complete metrics", () => {
    expect(assessP7ExecutionRobustness(results().slice(1)).verdict).toBe("INVALID_EVIDENCE");
    const rows = results();
    rows[1]!.cagr = NaN;
    expect(assessP7ExecutionRobustness(rows).verdict).toBe("INVALID_EVIDENCE");
  });
  it("does not interpret stress results when the reference mismatches", () => {
    const rows = results(); rows[0]!.cagr = 0.2;
    expect(assessP7ExecutionRobustness(rows).verdict).toBe("REFERENCE_MISMATCH");
  });
  it("keeps inclusive 50% drawdown and strictly positive return boundaries", () => {
    const rows = results(); rows[1]!.maxDrawdown = 0.5;
    expect(assessP7ExecutionRobustness(rows).verdict).toBe("ROBUST_IN_TESTED_SCENARIOS");
    rows[1]!.windowDrawdowns[4] = 0.500001;
    expect(assessP7ExecutionRobustness(rows).verdict).toBe("SENSITIVE_TO_ASSUMPTIONS");
    rows[1]!.windowDrawdowns[4] = 0.5; rows[1]!.netReturn = 0;
    expect(assessP7ExecutionRobustness(rows).verdict).toBe("SENSITIVE_TO_ASSUMPTIONS");
  });
  it("lets the model reject an invalid reference before completion", () => {
    const actor = createActor(p7ExecutionRobustnessMachine).start();
    actor.send({ type: "START" }); actor.send({ type: "DATA_READY" });
    const rows = results(); rows[0]!.maxDrawdown = 0.6;
    actor.send({ type: "REPLAY_READY", results: rows });
    expect(actor.getSnapshot().value).toBe("invalid");
    expect(actor.getSnapshot().context.assessment?.verdict).toBe("REFERENCE_MISMATCH");
    actor.stop();
  });
});
