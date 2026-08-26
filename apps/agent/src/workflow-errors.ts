import type { WorkflowError } from "@dodash/models";

export const storageWorkflowError = (retryable = true): WorkflowError => ({
  phase: "persistence",
  code: "PERSISTENCE_FAILURE",
  retryable,
});

export const executionWorkflowError = (
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase: "execution", code, retryable });

export const reconciliationWorkflowError = (
  code: WorkflowError["code"] = "RECONCILIATION_FAILURE",
  retryable = true,
): WorkflowError => ({ phase: "reconciliation", code, retryable });

export const authorizationWorkflowError = (): WorkflowError => ({
  phase: "authorization",
  code: "AUTHENTICATION_FAILURE",
  retryable: false,
});
