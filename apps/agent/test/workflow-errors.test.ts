import { describe, expect, it } from "vitest";

import {
  authorizationWorkflowError,
  executionWorkflowError,
  reconciliationWorkflowError,
  storageWorkflowError,
} from "../src/workflow-errors.js";

describe("workflow error factories", () => {
  it("construit des erreurs fermées sans état mutable partagé", () => {
    expect(storageWorkflowError()).toEqual({
      phase: "persistence",
      code: "PERSISTENCE_FAILURE",
      retryable: true,
    });
    expect(executionWorkflowError("ORDER_REJECTED", false)).toEqual({
      phase: "execution",
      code: "ORDER_REJECTED",
      retryable: false,
    });
    expect(reconciliationWorkflowError()).toEqual({
      phase: "reconciliation",
      code: "RECONCILIATION_FAILURE",
      retryable: true,
    });
    expect(authorizationWorkflowError()).toEqual({
      phase: "authorization",
      code: "AUTHENTICATION_FAILURE",
      retryable: false,
    });
  });
});
