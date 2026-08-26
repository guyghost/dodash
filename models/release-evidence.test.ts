import { describe, expect, it } from "vitest";

import {
  createReleaseEvidence,
  RELEASE_EVIDENCE_GATES,
  validateReleaseEvidence,
} from "./release-evidence.js";

const validInput = () => ({
  schemaVersion: 1 as const,
  releaseSha: "a".repeat(40),
  generatedAt: "2026-08-26T12:00:00.000Z",
  liveTradingEnabled: false as const,
  gates: Object.fromEntries(
    RELEASE_EVIDENCE_GATES.map((gate) => [gate, "passed"]),
  ),
});

describe("createReleaseEvidence", () => {
  it("accepte une release live-OFF dont tous les gates sont réussis", () => {
    const result = createReleaseEvidence(validInput());

    expect(result).toEqual({ ok: true, evidence: validInput() });
    if (result.ok) {
      expect(Object.isFrozen(result.evidence)).toBe(true);
      expect(Object.isFrozen(result.evidence.gates)).toBe(true);
    }
  });

  it("refuse un SHA qui n'est pas un identifiant Git complet canonique", () => {
    const result = createReleaseEvidence({
      ...validInput(),
      releaseSha: "A".repeat(40),
    });

    expect(result).toEqual({ ok: false, error: "INVALID_RELEASE_SHA" });
  });

  it("refuse un instant qui n'est pas un ISO UTC canonique", () => {
    const result = createReleaseEvidence({
      ...validInput(),
      generatedAt: "2026-08-26T14:00:00+02:00",
    });

    expect(result).toEqual({ ok: false, error: "INVALID_GENERATED_AT" });
  });

  it("refuse toute preuve qui n'établit pas littéralement live OFF", () => {
    const result = createReleaseEvidence({
      ...validInput(),
      liveTradingEnabled: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "LIVE_TRADING_NOT_DISABLED",
    });
  });

  it("refuse un gate absent ou non réussi", () => {
    const gates = validInput().gates;
    delete gates.audit;

    expect(createReleaseEvidence({ ...validInput(), gates })).toEqual({
      ok: false,
      error: "RELEASE_GATE_NOT_PASSED",
    });
    expect(
      createReleaseEvidence({
        ...validInput(),
        gates: { ...validInput().gates, test: "failed" },
      }),
    ).toEqual({ ok: false, error: "RELEASE_GATE_NOT_PASSED" });
  });
});

describe("validateReleaseEvidence", () => {
  it("accepte la preuve nominale après sérialisation", () => {
    const value: unknown = JSON.parse(JSON.stringify(validInput()));

    expect(validateReleaseEvidence(value)).toEqual({
      ok: true,
      evidence: validInput(),
    });
  });

  it("refuse une forme inconnue ou des champs supplémentaires", () => {
    expect(validateReleaseEvidence(null)).toEqual({
      ok: false,
      error: "INVALID_EVIDENCE",
    });
    expect(
      validateReleaseEvidence({ ...validInput(), deploymentSha: "a".repeat(40) }),
    ).toEqual({ ok: false, error: "INVALID_EVIDENCE" });
  });
});
