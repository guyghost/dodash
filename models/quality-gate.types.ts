export type QualityGateSource = "pre-commit" | "pre-push" | "ci";

export type QualityGateStage =
  | "environment"
  | "dependency-audit"
  | "secret-scan"
  | "check"
  | "test"
  | "build"
  | "artifact-test";

export type QualityGateErrorCode =
  | "ENVIRONMENT_INVALID"
  | "DEPENDENCY_AUDIT_FAILED"
  | "SECRET_SCAN_FAILED"
  | "CHECK_FAILED"
  | "TEST_FAILED"
  | "BUILD_FAILED"
  | "ARTIFACT_TEST_FAILED";

export type QualityGateError = Readonly<{
  code: QualityGateErrorCode;
  stage: QualityGateStage;
}>;

export type QualityGateContext = {
  source: QualityGateSource | null;
  lastError: QualityGateError | null;
};

export type QualityGateEvent =
  | { type: "GATE_REQUESTED"; source: QualityGateSource }
  | { type: "ENVIRONMENT_VALIDATED" }
  | { type: "ENVIRONMENT_FAILED" }
  | { type: "DEPENDENCY_AUDIT_PASSED" }
  | { type: "DEPENDENCY_AUDIT_FAILED" }
  | { type: "SECRET_SCAN_PASSED" }
  | { type: "SECRET_SCAN_FAILED" }
  | { type: "CHECK_PASSED" }
  | { type: "CHECK_FAILED" }
  | { type: "TESTS_PASSED" }
  | { type: "TESTS_FAILED" }
  | { type: "BUILD_PASSED" }
  | { type: "BUILD_FAILED" }
  | { type: "ARTIFACT_TESTS_PASSED" }
  | { type: "ARTIFACT_TESTS_FAILED" }
  | { type: "CANCEL_REQUESTED" }
  | { type: "RETRY_REQUESTED" }
  | { type: "RESET" };
