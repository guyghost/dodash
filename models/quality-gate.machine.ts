import { assign, setup } from "xstate";

import type {
  QualityGateContext,
  QualityGateError,
  QualityGateEvent,
} from "./quality-gate.types.js";

const errorFor = (event: QualityGateEvent): QualityGateError | null => {
  switch (event.type) {
    case "ENVIRONMENT_FAILED":
      return { code: "ENVIRONMENT_INVALID", stage: "environment" };
    case "CHECK_FAILED":
      return { code: "CHECK_FAILED", stage: "check" };
    case "TESTS_FAILED":
      return { code: "TEST_FAILED", stage: "test" };
    case "BUILD_FAILED":
      return { code: "BUILD_FAILED", stage: "build" };
    case "ARTIFACT_TESTS_FAILED":
      return { code: "ARTIFACT_TEST_FAILED", stage: "artifact-test" };
    default:
      return null;
  }
};

const activeStates = {
  on: {
    CANCEL_REQUESTED: "cancelled",
  },
} as const;

export const qualityGateMachine = setup({
  types: {
    context: {} as QualityGateContext,
    events: {} as QualityGateEvent,
  },
  guards: {
    isPreCommit: ({ context }) => context.source === "pre-commit",
  },
  actions: {
    initialize: assign(({ event }) =>
      event.type === "GATE_REQUESTED"
        ? { source: event.source, lastError: null }
        : {},
    ),
    clearError: assign({ lastError: null }),
    recordError: assign(({ event }) => ({ lastError: errorFor(event) })),
    reset: assign({ source: null, lastError: null }),
  },
}).createMachine({
  id: "qualityGate",
  initial: "idle",
  context: { source: null, lastError: null },
  states: {
    idle: {
      on: {
        GATE_REQUESTED: {
          target: "validatingEnvironment",
          actions: "initialize",
        },
      },
    },
    validatingEnvironment: {
      on: {
        ...activeStates.on,
        ENVIRONMENT_VALIDATED: "checking",
        ENVIRONMENT_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    checking: {
      on: {
        ...activeStates.on,
        CHECK_PASSED: [
          { guard: "isPreCommit", target: "passed" },
          { target: "testing" },
        ],
        CHECK_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    testing: {
      on: {
        ...activeStates.on,
        TESTS_PASSED: "building",
        TESTS_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    building: {
      on: {
        ...activeStates.on,
        BUILD_PASSED: "testingArtifact",
        BUILD_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    testingArtifact: {
      on: {
        ...activeStates.on,
        ARTIFACT_TESTS_PASSED: "passed",
        ARTIFACT_TESTS_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    failed: {
      on: {
        RETRY_REQUESTED: {
          target: "validatingEnvironment",
          actions: "clearError",
        },
        RESET: { target: "idle", actions: "reset" },
      },
    },
    passed: { type: "final" },
    cancelled: { type: "final" },
  },
});
