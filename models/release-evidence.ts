export const RELEASE_EVIDENCE_GATES = Object.freeze([
  "install",
  "audit",
  "secretScan",
  "check",
  "test",
  "build",
  "artifactTest",
] as const);

export type ReleaseEvidenceGate = (typeof RELEASE_EVIDENCE_GATES)[number];
export type ReleaseEvidenceError =
  | "INVALID_EVIDENCE"
  | "INVALID_RELEASE_SHA"
  | "INVALID_GENERATED_AT"
  | "LIVE_TRADING_NOT_DISABLED"
  | "RELEASE_GATE_NOT_PASSED";

export interface ReleaseEvidenceInput {
  readonly schemaVersion: 1;
  readonly releaseSha: string;
  readonly generatedAt: string;
  readonly liveTradingEnabled: boolean;
  readonly gates: Readonly<Record<string, unknown>>;
}

export interface ReleaseEvidence {
  readonly schemaVersion: 1;
  readonly releaseSha: string;
  readonly generatedAt: string;
  readonly liveTradingEnabled: false;
  readonly gates: Readonly<Record<ReleaseEvidenceGate, "passed">>;
}

export type ReleaseEvidenceResult =
  | { readonly ok: true; readonly evidence: ReleaseEvidence }
  | { readonly ok: false; readonly error: ReleaseEvidenceError };

const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "releaseSha",
  "generatedAt",
  "liveTradingEnabled",
  "gates",
]);

const isCanonicalUtcInstant = (value: string): boolean => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

const allGatesPassed = (
  gates: Readonly<Record<string, unknown>>,
): boolean =>
  Object.keys(gates).length === RELEASE_EVIDENCE_GATES.length &&
  RELEASE_EVIDENCE_GATES.every((gate) => gates[gate] === "passed");

export const createReleaseEvidence = (
  input: ReleaseEvidenceInput,
): ReleaseEvidenceResult => {
  if (!RELEASE_SHA_PATTERN.test(input.releaseSha)) {
    return { ok: false, error: "INVALID_RELEASE_SHA" };
  }
  if (!isCanonicalUtcInstant(input.generatedAt)) {
    return { ok: false, error: "INVALID_GENERATED_AT" };
  }
  if (input.liveTradingEnabled !== false) {
    return { ok: false, error: "LIVE_TRADING_NOT_DISABLED" };
  }
  if (!allGatesPassed(input.gates)) {
    return { ok: false, error: "RELEASE_GATE_NOT_PASSED" };
  }

  const gates = Object.freeze(
    Object.fromEntries(RELEASE_EVIDENCE_GATES.map((gate) => [gate, "passed"])),
  ) as Readonly<Record<ReleaseEvidenceGate, "passed">>;
  return {
    ok: true,
    evidence: Object.freeze({
      schemaVersion: 1,
      releaseSha: input.releaseSha,
      generatedAt: input.generatedAt,
      liveTradingEnabled: false,
      gates,
    }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateReleaseEvidence = (
  value: unknown,
): ReleaseEvidenceResult => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== EVIDENCE_KEYS.length ||
    !EVIDENCE_KEYS.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== 1 ||
    typeof value.releaseSha !== "string" ||
    typeof value.generatedAt !== "string" ||
    typeof value.liveTradingEnabled !== "boolean" ||
    !isRecord(value.gates)
  ) {
    return { ok: false, error: "INVALID_EVIDENCE" };
  }

  return createReleaseEvidence({
    schemaVersion: 1,
    releaseSha: value.releaseSha,
    generatedAt: value.generatedAt,
    liveTradingEnabled: value.liveTradingEnabled,
    gates: value.gates,
  });
};
