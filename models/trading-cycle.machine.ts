import { assign, setup } from "xstate";

import type {
  RetryAttempts,
  RetryLimits,
  TradingCycleContext,
  TradingCycleEvent,
  TradingCycleInput,
  WorkflowError,
} from "./trading-cycle.types.js";

const defaultRetryLimits: RetryLimits = {
  schedule: 3,
  marketData: 3,
  authorization: 2,
  execution: 1,
  reconciliation: 4,
  persistence: 5,
};

const emptyAttempts = (): RetryAttempts => ({
  schedule: 0,
  marketData: 0,
  authorization: 0,
  execution: 0,
  reconciliation: 0,
  persistence: 0,
});

const eventError = (event: TradingCycleEvent): WorkflowError | null =>
  "error" in event ? event.error : null;

export const tradingCycleMachine = setup({
  types: {
    context: {} as TradingCycleContext,
    events: {} as TradingCycleEvent,
    input: {} as TradingCycleInput,
  },
  guards: {
    canStart: ({ event }) =>
      event.type === "START_REQUESTED" &&
      event.permissions.canControl &&
      event.permissions.canTrade,
    canControl: ({ event }) =>
      (event.type === "STOP_REQUESTED" ||
        event.type === "KILL_SWITCH_ENGAGED" ||
        event.type === "RESET") &&
      event.permissions.canControl,
    isNewAlarm: ({ context, event }) =>
      event.type === "ALARM_FIRED" && event.cycleId !== context.cycleId,
    isDuplicateDecisionCandle: ({ context, event }) =>
      event.type === "MARKET_DATA_READY" &&
      context.lastDecisionCandleClosedAt !== null &&
      event.candleClosedAt <= context.lastDecisionCandleClosedAt,
    isFreshMarketData: ({ context, event }) =>
      event.type === "MARKET_DATA_READY" &&
      context.triggeredAt !== null &&
      event.candleClosedAt <= context.triggeredAt &&
      context.triggeredAt - event.candleClosedAt <= context.maxMarketStalenessMs,
    hasAllocatedOrders: ({ event }) =>
      event.type === "ALLOCATION_COMPLETED" && event.orderCount > 0,
    hasTradePermission: ({ context }) => context.permissions.canTrade,
    authorizationIsUsable: ({ event }) =>
      event.type === "AUTHORIZATION_READY" &&
      event.expiresAt > event.issuedAt &&
      event.expiresAt - event.issuedAt <= 120_000,
    canRetryInvalidAuthorization: ({ context, event }) =>
      event.type === "AUTHORIZATION_READY" &&
      context.attempts.authorization < context.retryLimits.authorization,
    shouldRetrySchedule: ({ context, event }) =>
      event.type === "SCHEDULE_FAILED" &&
      event.error.retryable &&
      context.attempts.schedule < context.retryLimits.schedule,
    shouldRetryMarketData: ({ context, event }) =>
      event.type === "MARKET_DATA_FAILED" &&
      event.error.retryable &&
      context.attempts.marketData < context.retryLimits.marketData,
    canRetryStaleMarketData: ({ context }) =>
      context.attempts.marketData < context.retryLimits.marketData,
    shouldRetryAuthorization: ({ context, event }) =>
      event.type === "AUTHORIZATION_FAILED" &&
      event.error.retryable &&
      context.attempts.authorization < context.retryLimits.authorization,
    shouldRetryExecution: ({ context, event }) =>
      event.type === "ORDER_REJECTED" &&
      event.error.retryable &&
      context.attempts.execution < context.retryLimits.execution,
    shouldRetryReconciliation: ({ context, event }) =>
      event.type === "RECONCILIATION_FAILED" &&
      event.error.retryable &&
      context.attempts.reconciliation < context.retryLimits.reconciliation,
    shouldRetryPersistence: ({ context, event }) =>
      event.type === "PERSIST_FAILED" &&
      event.error.retryable &&
      context.attempts.persistence < context.retryLimits.persistence,
    shutdownRequested: ({ context }) => context.shutdownMode !== "none",
    shouldStopAfterPersistence: ({ context }) =>
      context.shutdownMode === "stop",
    shouldHaltAfterPersistence: ({ context }) =>
      context.shutdownMode === "kill-switch" ||
      context.shutdownMode === "permission-revoked",
  },
  actions: {
    initializeRun: assign(({ context, event }) => {
      if (event.type !== "START_REQUESTED") return {};
      return {
        permissions: event.permissions,
        shutdownMode: "none" as const,
        outcome: "IDLE" as const,
        lastError: null,
        attempts: { ...context.attempts, schedule: 0 },
      };
    }),
    recordStartDenied: assign(({ event }) => {
      if (event.type !== "START_REQUESTED") return {};
      return {
        lastError: {
          phase: "schedule" as const,
          code: event.permissions.canControl
            ? ("TRADE_PERMISSION_REQUIRED" as const)
            : ("CONTROL_PERMISSION_REQUIRED" as const),
          retryable: false,
        },
      };
    }),
    recordControlDenied: assign({
      lastError: {
        phase: "cancellation",
        code: "CONTROL_PERMISSION_REQUIRED",
        retryable: false,
      },
    }),
    recordSchedule: assign(({ context, event }) =>
      event.type === "SCHEDULE_SUCCEEDED"
        ? {
            nextWakeAt: event.nextWakeAt,
            attempts: { ...context.attempts, schedule: 0 },
          }
        : {},
    ),
    beginCycle: assign(({ event }) =>
      event.type === "ALARM_FIRED"
        ? {
            cycleId: event.cycleId,
            triggeredAt: event.triggeredAt,
            nextWakeAt: null,
            marketSnapshotId: null,
            indicatorsId: null,
            signalsId: null,
            decisionId: null,
            clientOrderId: null,
            exchangeOrderId: null,
            orderMayBeInFlight: false,
            authorizationExpiresAt: null,
            outcome: "RUNNING" as const,
            lastError: null,
            attempts: emptyAttempts(),
          }
        : {},
    ),
    recordDuplicateAlarm: assign({
      lastError: () => ({
        phase: "schedule" as const,
        code: "DUPLICATE_ALARM" as const,
        retryable: false,
      }),
    }),
    recordMarketData: assign(({ context, event }) =>
      event.type === "MARKET_DATA_READY"
        ? {
            marketSnapshotId: event.snapshotId,
            lastDecisionCandleClosedAt: event.candleClosedAt,
            attempts: { ...context.attempts, marketData: 0 },
          }
        : {},
    ),
    recordDuplicateMarketData: assign(({ context, event }) =>
      event.type === "MARKET_DATA_READY"
        ? {
            marketSnapshotId: event.snapshotId,
            attempts: { ...context.attempts, marketData: 0 },
          }
        : {},
    ),
    recordStaleMarketData: assign(({ context }) => ({
      lastError: {
        phase: "market-data" as const,
        code: "STALE_MARKET_DATA" as const,
        retryable: true,
      },
      attempts: {
        ...context.attempts,
        marketData: context.attempts.marketData + 1,
      },
    })),
    recordIndicators: assign(({ event }) =>
      event.type === "INDICATORS_COMPUTED"
        ? { indicatorsId: event.indicatorsId }
        : {},
    ),
    recordSignals: assign(({ event }) =>
      event.type === "STRATEGIES_EVALUATED"
        ? { signalsId: event.signalsId }
        : {},
    ),
    recordDecision: assign(({ event }) =>
      event.type === "ALLOCATION_COMPLETED"
        ? { decisionId: event.decisionId }
        : {},
    ),
    markNoAction: assign({ outcome: "NO_ACTION" }),
    markRiskRejected: assign({ outcome: "RISK_REJECTED" }),
    recordOrderIntent: assign(({ event }) =>
      event.type === "ORDER_INTENT_PERSISTED"
        ? { clientOrderId: event.clientOrderId }
        : {},
    ),
    recordAuthorization: assign(({ event }) =>
      event.type === "AUTHORIZATION_READY"
        ? { authorizationExpiresAt: event.expiresAt }
        : {},
    ),
    recordInvalidAuthorization: assign({
      authorizationExpiresAt: null,
      lastError: {
        phase: "authorization",
        code: "AUTHORIZATION_EXPIRED",
        retryable: true,
      },
    }),
    markOrderSubmissionStarted: assign({ orderMayBeInFlight: true }),
    recordOrderConfirmed: assign(({ event }) =>
      event.type === "ORDER_CONFIRMED"
        ? {
            exchangeOrderId: event.exchangeOrderId,
            orderMayBeInFlight: false,
            outcome: "ORDER_CONFIRMED" as const,
          }
        : {},
    ),
    recordOrderRejected: assign({
      orderMayBeInFlight: false,
      outcome: "ORDER_REJECTED",
    }),
    recordReconciliation: assign(({ event }) =>
      event.type === "ORDER_RECONCILED"
        ? {
            exchangeOrderId: event.exchangeOrderId,
            orderMayBeInFlight: false,
            outcome:
              event.exchangeOrderId === null
                ? ("ORDER_REJECTED" as const)
                : ("ORDER_CONFIRMED" as const),
          }
        : {},
    ),
    requestStop: assign({ shutdownMode: "stop" }),
    requestKillSwitch: assign({ shutdownMode: "kill-switch" }),
    revokePermission: assign(({ context }) => ({
      permissions: { ...context.permissions, canTrade: false },
      shutdownMode: "permission-revoked" as const,
      lastError: {
        phase: "execution" as const,
        code: "PERMISSION_REVOKED" as const,
        retryable: false,
      },
    })),
    markCancelled: assign({
      outcome: "CANCELLED",
      orderMayBeInFlight: false,
    }),
    recordError: assign(({ event }) => ({ lastError: eventError(event) })),
    markFailed: assign({ outcome: "FAILED" }),
    incrementScheduleAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        schedule: context.attempts.schedule + 1,
      },
    })),
    incrementMarketDataAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        marketData: context.attempts.marketData + 1,
      },
    })),
    incrementAuthorizationAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        authorization: context.attempts.authorization + 1,
      },
    })),
    incrementExecutionAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        execution: context.attempts.execution + 1,
      },
      orderMayBeInFlight: false,
    })),
    incrementReconciliationAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        reconciliation: context.attempts.reconciliation + 1,
      },
    })),
    incrementPersistenceAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        persistence: context.attempts.persistence + 1,
      },
    })),
    clearTransientAuthorization: assign({ authorizationExpiresAt: null }),
    resetMachine: assign(({ context }) => ({
      permissions: { canControl: false, canTrade: false },
      cycleId: null,
      triggeredAt: null,
      nextWakeAt: null,
      marketSnapshotId: null,
      indicatorsId: null,
      signalsId: null,
      decisionId: null,
      clientOrderId: null,
      exchangeOrderId: null,
      orderMayBeInFlight: false,
      authorizationExpiresAt: null,
      shutdownMode: "none" as const,
      outcome: "IDLE" as const,
      lastError: null,
      attempts: emptyAttempts(),
      retryLimits: context.retryLimits,
    })),
  },
}).createMachine({
  id: "tradingCycle",
  context: ({ input }) => ({
    agentId: input.agentId,
    strategyIds: input.strategyIds,
    permissions: { canControl: false, canTrade: false },
    cycleId: null,
    triggeredAt: null,
    nextWakeAt: null,
    marketSnapshotId: null,
    lastDecisionCandleClosedAt: input.lastDecisionCandleClosedAt ?? null,
    indicatorsId: null,
    signalsId: null,
    decisionId: null,
    clientOrderId: null,
    exchangeOrderId: null,
    orderMayBeInFlight: false,
    authorizationExpiresAt: null,
    shutdownMode: "none",
    outcome: "IDLE",
    lastError: null,
    maxMarketStalenessMs: input.maxMarketStalenessMs ?? 90_000,
    retryLimits: { ...defaultRetryLimits, ...input.retryLimits },
    attempts: emptyAttempts(),
  }),
  initial: "stopped",
  on: {
    STOP_REQUESTED: [
      { guard: "canControl", actions: "requestStop" },
      { actions: "recordControlDenied" },
    ],
    KILL_SWITCH_ENGAGED: [
      { guard: "canControl", actions: "requestKillSwitch" },
      { actions: "recordControlDenied" },
    ],
    PERMISSION_REVOKED: { actions: "revokePermission" },
  },
  states: {
    stopped: {
      on: {
        START_REQUESTED: [
          {
            guard: "canStart",
            target: "scheduling",
            actions: "initializeRun",
          },
          { actions: "recordStartDenied" },
        ],
        KILL_SWITCH_ENGAGED: [
          {
            guard: "canControl",
            target: "halted",
            actions: "requestKillSwitch",
          },
          { actions: "recordControlDenied" },
        ],
      },
    },
    scheduling: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        SCHEDULE_SUCCEEDED: {
          target: "waiting",
          actions: "recordSchedule",
        },
        SCHEDULE_FAILED: [
          {
            guard: "shouldRetrySchedule",
            target: "retryingSchedule",
            actions: ["recordError", "incrementScheduleAttempt"],
          },
          { target: "failed", actions: ["recordError", "markFailed"] },
        ],
      },
    },
    retryingSchedule: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        RETRY_TIMER_ELAPSED: "scheduling",
      },
    },
    waiting: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        ALARM_FIRED: [
          {
            guard: "isNewAlarm",
            target: "fetchingMarketData",
            actions: "beginCycle",
          },
          { actions: "recordDuplicateAlarm" },
        ],
      },
    },
    fetchingMarketData: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        MARKET_DATA_READY: [
          {
            guard: "isDuplicateDecisionCandle",
            target: "persisting",
            actions: ["recordDuplicateMarketData", "markNoAction"],
          },
          {
            guard: "isFreshMarketData",
            target: "computingIndicators",
            actions: "recordMarketData",
          },
          {
            guard: "canRetryStaleMarketData",
            target: "retryingMarketData",
            actions: "recordStaleMarketData",
          },
          {
            target: "persisting",
            actions: ["recordStaleMarketData", "markNoAction"],
          },
        ],
        MARKET_DATA_FAILED: [
          {
            guard: "shouldRetryMarketData",
            target: "retryingMarketData",
            actions: ["recordError", "incrementMarketDataAttempt"],
          },
          {
            target: "persisting",
            actions: ["recordError", "markFailed"],
          },
        ],
      },
    },
    retryingMarketData: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        RETRY_TIMER_ELAPSED: "fetchingMarketData",
      },
    },
    computingIndicators: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        INDICATORS_COMPUTED: {
          target: "evaluatingStrategies",
          actions: "recordIndicators",
        },
        INDICATORS_FAILED: {
          target: "persisting",
          actions: ["recordError", "markFailed"],
        },
      },
    },
    evaluatingStrategies: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        STRATEGIES_EVALUATED: {
          target: "allocating",
          actions: "recordSignals",
        },
        STRATEGIES_FAILED: {
          target: "persisting",
          actions: ["recordError", "markFailed"],
        },
      },
    },
    allocating: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        ALLOCATION_COMPLETED: [
          {
            guard: "hasAllocatedOrders",
            target: "checkingRisk",
            actions: "recordDecision",
          },
          {
            target: "persisting",
            actions: ["recordDecision", "markNoAction"],
          },
        ],
        ALLOCATION_FAILED: {
          target: "persisting",
          actions: ["recordError", "markFailed"],
        },
      },
    },
    checkingRisk: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        RISK_APPROVED: [
          { guard: "hasTradePermission", target: "persistingOrderIntent" },
          { target: "cancelling", actions: "revokePermission" },
        ],
        RISK_REJECTED: {
          target: "persisting",
          actions: "markRiskRejected",
        },
        RISK_FAILED: {
          target: "persisting",
          actions: ["recordError", "markFailed"],
        },
      },
    },
    persistingOrderIntent: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        ORDER_INTENT_PERSISTED: {
          target: "authorizing",
          actions: "recordOrderIntent",
        },
        ORDER_INTENT_FAILED: {
          target: "persisting",
          actions: ["recordError", "markFailed"],
        },
      },
    },
    authorizing: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        AUTHORIZATION_READY: [
          {
            guard: "authorizationIsUsable",
            target: "submittingOrder",
            actions: ["recordAuthorization", "markOrderSubmissionStarted"],
          },
          {
            guard: "canRetryInvalidAuthorization",
            target: "retryingAuthorization",
            actions: [
              "recordInvalidAuthorization",
              "incrementAuthorizationAttempt",
            ],
          },
          {
            target: "persisting",
            actions: ["recordInvalidAuthorization", "markFailed"],
          },
        ],
        AUTHORIZATION_FAILED: [
          {
            guard: "shouldRetryAuthorization",
            target: "retryingAuthorization",
            actions: ["recordError", "incrementAuthorizationAttempt"],
          },
          {
            target: "persisting",
            actions: ["recordError", "markFailed"],
          },
        ],
      },
    },
    retryingAuthorization: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        RETRY_TIMER_ELAPSED: "authorizing",
      },
    },
    submittingOrder: {
      always: {
        guard: "shutdownRequested",
        target: "reconcilingOrder",
      },
      on: {
        ORDER_CONFIRMED: {
          target: "persisting",
          actions: "recordOrderConfirmed",
        },
        ORDER_REJECTED: [
          {
            guard: "shouldRetryExecution",
            target: "retryingExecution",
            actions: [
              "recordError",
              "incrementExecutionAttempt",
              "clearTransientAuthorization",
            ],
          },
          {
            target: "persisting",
            actions: ["recordError", "recordOrderRejected"],
          },
        ],
        ORDER_OUTCOME_UNKNOWN: {
          target: "reconcilingOrder",
          actions: "recordError",
        },
      },
    },
    retryingExecution: {
      always: {
        guard: "shutdownRequested",
        target: "cancelling",
      },
      on: {
        RETRY_TIMER_ELAPSED: "authorizing",
      },
    },
    reconcilingOrder: {
      on: {
        ORDER_RECONCILED: {
          target: "persisting",
          actions: "recordReconciliation",
        },
        RECONCILIATION_FAILED: [
          {
            guard: "shouldRetryReconciliation",
            target: "retryingReconciliation",
            actions: ["recordError", "incrementReconciliationAttempt"],
          },
          { target: "failed", actions: ["recordError", "markFailed"] },
        ],
      },
    },
    retryingReconciliation: {
      on: {
        RETRY_TIMER_ELAPSED: "reconcilingOrder",
      },
    },
    cancelling: {
      on: {
        EFFECT_CANCELLED: {
          target: "persisting",
          actions: "markCancelled",
        },
        EFFECT_CANCEL_FAILED: {
          target: "persisting",
          actions: ["recordError", "markCancelled"],
        },
      },
    },
    persisting: {
      on: {
        PERSIST_SUCCEEDED: [
          { guard: "shouldStopAfterPersistence", target: "stopped" },
          { guard: "shouldHaltAfterPersistence", target: "halted" },
          { target: "scheduling" },
        ],
        PERSIST_FAILED: [
          {
            guard: "shouldRetryPersistence",
            target: "retryingPersistence",
            actions: ["recordError", "incrementPersistenceAttempt"],
          },
          { target: "failed", actions: ["recordError", "markFailed"] },
        ],
      },
    },
    retryingPersistence: {
      on: {
        RETRY_TIMER_ELAPSED: "persisting",
      },
    },
    failed: {
      on: {
        RESET: [
          {
            guard: "canControl",
            target: "stopped",
            actions: "resetMachine",
          },
          { actions: "recordControlDenied" },
        ],
      },
    },
    halted: {
      on: {
        RESET: [
          {
            guard: "canControl",
            target: "stopped",
            actions: "resetMachine",
          },
          { actions: "recordControlDenied" },
        ],
      },
    },
  },
});
