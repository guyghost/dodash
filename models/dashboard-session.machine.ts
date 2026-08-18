import { assign, setup } from "xstate";

import type {
  DashboardError,
  DashboardSessionContext,
  DashboardSessionEvent,
  DashboardSessionInput,
} from "./dashboard-session.types.js";

const eventError = (event: DashboardSessionEvent): DashboardError | null =>
  event.type === "REQUEST_FAILED" ? event.error : null;

const validRemoteState = (
  event: DashboardSessionEvent,
): event is Extract<
  DashboardSessionEvent,
  { readonly type: "STATE_LOADED" | "COMMAND_SUCCEEDED" }
> =>
  (event.type === "STATE_LOADED" || event.type === "COMMAND_SUCCEEDED") &&
  Number.isSafeInteger(event.remoteUpdatedAt) &&
  event.remoteUpdatedAt >= 0;

export const dashboardSessionMachine = setup({
  types: {
    context: {} as DashboardSessionContext,
    events: {} as DashboardSessionEvent,
    input: {} as DashboardSessionInput,
  },
  guards: {
    validConnectionRequest: ({ event }) =>
      event.type === "CONNECT_REQUESTED" &&
      event.credentialPresent &&
      event.agentName.trim().length > 0 &&
      event.agentName.length <= 200,
    validRemoteState: ({ event }) => validRemoteState(event),
    canIssueCommand: ({ event }) =>
      event.type === "COMMAND_REQUESTED" &&
      event.permissions.canControl &&
      (event.command !== "start" && event.command !== "tick"
        ? true
        : event.permissions.canTrade),
    canRequestKill: ({ event }) =>
      event.type === "KILL_CONFIRMATION_REQUESTED" &&
      event.permissions.canControl,
    canConfirmKill: ({ event }) =>
      event.type === "KILL_CONFIRMED" && event.permissions.canControl,
  },
  actions: {
    initializeConnection: assign(({ event }) =>
      event.type === "CONNECT_REQUESTED"
        ? {
            agentName: event.agentName.trim(),
            credentialPresent: true,
            remotePhase: null,
            pendingCommand: null,
            remoteUpdatedAt: null,
            lastError: null,
          }
        : {},
    ),
    rejectConnection: assign(({ event }) => ({
      lastError:
        event.type === "CONNECT_REQUESTED" && !event.credentialPresent
          ? ({ code: "INVALID_CREDENTIAL", retryable: false } as const)
          : ({ code: "INVALID_TARGET", retryable: false } as const),
    })),
    recordRemoteState: assign(({ event }) =>
      validRemoteState(event)
        ? {
            remotePhase: event.remotePhase,
            remoteUpdatedAt: event.remoteUpdatedAt,
            pendingCommand: null,
            lastError: null,
          }
        : {},
    ),
    recordInvalidResponse: assign({
      pendingCommand: null,
      lastError: { code: "INVALID_RESPONSE", retryable: false },
    }),
    recordError: assign(({ event }) => ({
      pendingCommand: null,
      lastError: eventError(event),
    })),
    clearError: assign({ lastError: null }),
    recordCommand: assign(({ event }) =>
      event.type === "COMMAND_REQUESTED"
        ? { pendingCommand: event.command, lastError: null }
        : {},
    ),
    recordKill: assign({ pendingCommand: "kill", lastError: null }),
    clearCommand: assign({ pendingCommand: null }),
    recordCommandDenied: assign(({ event }) => ({
      pendingCommand: null,
      lastError:
        event.type === "COMMAND_REQUESTED" &&
        (event.command === "start" || event.command === "tick") &&
        !event.permissions.canTrade
          ? ({ code: "TRADE_PERMISSION_REQUIRED", retryable: false } as const)
          : ({ code: "CONTROL_PERMISSION_REQUIRED", retryable: false } as const),
    })),
    recordControlDenied: assign({
      pendingCommand: null,
      lastError: { code: "CONTROL_PERMISSION_REQUIRED", retryable: false },
    }),
    disconnect: assign(({ context }) => ({
      agentName: context.agentName,
      credentialPresent: false,
      remotePhase: null,
      pendingCommand: null,
      remoteUpdatedAt: null,
      lastError: null,
    })),
  },
}).createMachine({
  id: "dashboardSession",
  context: ({ input }) => ({
    agentName: input.defaultAgentName?.trim() || null,
    credentialPresent: false,
    remotePhase: null,
    pendingCommand: null,
    remoteUpdatedAt: null,
    lastError: null,
  }),
  initial: "disconnected",
  on: {
    DISCONNECT_REQUESTED: { target: ".disconnected", actions: "disconnect" },
  },
  states: {
    disconnected: {
      on: {
        CONNECT_REQUESTED: [
          {
            guard: "validConnectionRequest",
            target: "loading",
            actions: "initializeConnection",
          },
          { actions: "rejectConnection" },
        ],
      },
    },
    loading: {
      on: {
        STATE_LOADED: [
          { guard: "validRemoteState", target: "ready", actions: "recordRemoteState" },
          { target: "error", actions: "recordInvalidResponse" },
        ],
        REQUEST_FAILED: { target: "error", actions: "recordError" },
      },
    },
    ready: {
      on: {
        REFRESH_REQUESTED: { target: "refreshing", actions: "clearError" },
        COMMAND_REQUESTED: [
          {
            guard: "canIssueCommand",
            target: "commanding",
            actions: "recordCommand",
          },
          { actions: "recordCommandDenied" },
        ],
        KILL_CONFIRMATION_REQUESTED: [
          { guard: "canRequestKill", target: "confirmingKill" },
          { actions: "recordControlDenied" },
        ],
      },
    },
    refreshing: {
      on: {
        STATE_LOADED: [
          { guard: "validRemoteState", target: "ready", actions: "recordRemoteState" },
          { target: "ready", actions: "recordInvalidResponse" },
        ],
        REQUEST_FAILED: { target: "ready", actions: "recordError" },
      },
    },
    confirmingKill: {
      on: {
        KILL_CONFIRMED: [
          { guard: "canConfirmKill", target: "commanding", actions: "recordKill" },
          { target: "ready", actions: "recordControlDenied" },
        ],
        KILL_CANCELLED: { target: "ready", actions: "clearCommand" },
      },
    },
    commanding: {
      on: {
        COMMAND_SUCCEEDED: [
          { guard: "validRemoteState", target: "ready", actions: "recordRemoteState" },
          { target: "ready", actions: "recordInvalidResponse" },
        ],
        REQUEST_FAILED: { target: "ready", actions: "recordError" },
      },
    },
    error: {
      on: {
        RETRY_REQUESTED: { target: "loading", actions: "clearError" },
      },
    },
  },
});
