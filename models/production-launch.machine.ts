import { assign, setup } from "xstate";

import {
  assessCanaryEvidence,
  assessEngineeringEvidence,
  assessOperationsEvidence,
  assessProductionLaunchScope,
  assessResearchEvidence,
  assessRiskEvidence,
} from "./production-launch.js";
import type {
  ProductionLaunchContext,
  ProductionLaunchEvent,
  ProductionLaunchScope,
  ProductionLaunchStage,
} from "./production-launch.types.js";

const activeState = {
  on: { CANCEL_REQUESTED: "#productionLaunch.cancelled" },
} as const;

const appendStage = (
  stages: readonly ProductionLaunchStage[],
  stage: ProductionLaunchStage,
): readonly ProductionLaunchStage[] => [...stages, stage];

export const productionLaunchMachine = setup({
  types: {
    context: {} as ProductionLaunchContext,
    events: {} as ProductionLaunchEvent,
    input: {} as ProductionLaunchScope,
  },
  guards: {
    launchScopeAccepted: ({ context }) =>
      assessProductionLaunchScope(context).ok,
    researchAccepted: ({ context, event }) =>
      event.type === "RESEARCH_EVIDENCE_SUBMITTED" &&
      assessResearchEvidence(context, event.evidence).ok,
    riskAccepted: ({ event }) =>
      event.type === "RISK_EVIDENCE_SUBMITTED" &&
      assessRiskEvidence(event.evidence).ok,
    engineeringAccepted: ({ context, event }) =>
      event.type === "ENGINEERING_EVIDENCE_SUBMITTED" &&
      assessEngineeringEvidence(context, event.evidence).ok,
    operationsAccepted: ({ context, event }) =>
      event.type === "OPERATIONS_EVIDENCE_SUBMITTED" &&
      assessOperationsEvidence(context, event.evidence).ok,
    canaryAccepted: ({ context, event }) =>
      event.type === "CANARY_EVIDENCE_SUBMITTED" &&
      assessCanaryEvidence(context, event.evidence).ok,
  },
  actions: {
    passResearch: assign({
      passedStages: ({ context }) => appendStage(context.passedStages, "research"),
    }),
    passRisk: assign({
      passedStages: ({ context }) => appendStage(context.passedStages, "risk"),
    }),
    passEngineering: assign({
      passedStages: ({ context }) =>
        appendStage(context.passedStages, "engineering"),
    }),
    passOperations: assign({
      passedStages: ({ context }) =>
        appendStage(context.passedStages, "operations"),
    }),
    passCanary: assign({
      passedStages: ({ context }) => appendStage(context.passedStages, "canary"),
    }),
    rejectResearch: assign(({ context, event }) => {
      if (event.type !== "RESEARCH_EVIDENCE_SUBMITTED") return {};
      const result = assessResearchEvidence(context, event.evidence);
      return result.ok
        ? {}
        : { failedStage: "research" as const, reasonCode: result.reasonCode };
    }),
    rejectRisk: assign(({ event }) => {
      if (event.type !== "RISK_EVIDENCE_SUBMITTED") return {};
      const result = assessRiskEvidence(event.evidence);
      return result.ok
        ? {}
        : { failedStage: "risk" as const, reasonCode: result.reasonCode };
    }),
    rejectEngineering: assign(({ context, event }) => {
      if (event.type !== "ENGINEERING_EVIDENCE_SUBMITTED") return {};
      const result = assessEngineeringEvidence(context, event.evidence);
      return result.ok
        ? {}
        : { failedStage: "engineering" as const, reasonCode: result.reasonCode };
    }),
    rejectOperations: assign(({ context, event }) => {
      if (event.type !== "OPERATIONS_EVIDENCE_SUBMITTED") return {};
      const result = assessOperationsEvidence(context, event.evidence);
      return result.ok
        ? {}
        : { failedStage: "operations" as const, reasonCode: result.reasonCode };
    }),
    rejectCanary: assign(({ context, event }) => {
      if (event.type !== "CANARY_EVIDENCE_SUBMITTED") return {};
      const result = assessCanaryEvidence(context, event.evidence);
      return result.ok
        ? {}
        : { failedStage: "canary" as const, reasonCode: result.reasonCode };
    }),
    clearAssessment: assign({
      passedStages: [],
      failedStage: null,
      reasonCode: null,
    }),
    rejectInvalidScope: assign({
      passedStages: [],
      failedStage: "research",
      reasonCode: "RESEARCH_SCOPE_MISMATCH",
    }),
  },
}).createMachine({
  id: "productionLaunch",
  initial: "idle",
  context: ({ input }) => ({
    releaseSha: input.releaseSha,
    policyId: input.policyId,
    productIds: [...input.productIds],
    evaluatedAt: input.evaluatedAt,
    passedStages: [],
    failedStage: null,
    reasonCode: null,
  }),
  states: {
    idle: {
      on: {
        LAUNCH_REQUESTED: [
          { guard: "launchScopeAccepted", target: "assessingResearch" },
          { target: "rejected", actions: "rejectInvalidScope" },
        ],
      },
    },
    assessingResearch: {
      ...activeState,
      on: {
        ...activeState.on,
        RESEARCH_EVIDENCE_SUBMITTED: [
          {
            guard: "researchAccepted",
            target: "assessingRisk",
            actions: "passResearch",
          },
          { target: "rejected", actions: "rejectResearch" },
        ],
      },
    },
    assessingRisk: {
      ...activeState,
      on: {
        ...activeState.on,
        RISK_EVIDENCE_SUBMITTED: [
          {
            guard: "riskAccepted",
            target: "assessingEngineering",
            actions: "passRisk",
          },
          { target: "rejected", actions: "rejectRisk" },
        ],
      },
    },
    assessingEngineering: {
      ...activeState,
      on: {
        ...activeState.on,
        ENGINEERING_EVIDENCE_SUBMITTED: [
          {
            guard: "engineeringAccepted",
            target: "assessingOperations",
            actions: "passEngineering",
          },
          { target: "rejected", actions: "rejectEngineering" },
        ],
      },
    },
    assessingOperations: {
      ...activeState,
      on: {
        ...activeState.on,
        OPERATIONS_EVIDENCE_SUBMITTED: [
          {
            guard: "operationsAccepted",
            target: "assessingCanary",
            actions: "passOperations",
          },
          { target: "rejected", actions: "rejectOperations" },
        ],
      },
    },
    assessingCanary: {
      ...activeState,
      on: {
        ...activeState.on,
        CANARY_EVIDENCE_SUBMITTED: [
          {
            guard: "canaryAccepted",
            target: "approved",
            actions: "passCanary",
          },
          { target: "rejected", actions: "rejectCanary" },
        ],
      },
    },
    rejected: {
      on: {
        RETRY_REQUESTED: {
          target: "assessingResearch",
          actions: "clearAssessment",
        },
        RESET: { target: "idle", actions: "clearAssessment" },
      },
    },
    approved: { type: "final" },
    cancelled: { type: "final" },
  },
});
