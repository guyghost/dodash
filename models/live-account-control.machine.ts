import { assign, setup } from "xstate";

import type {
  LiveAccountControlAttempts,
  LiveAccountControlContext,
  LiveAccountControlEvent,
  LiveAccountControlInput,
  LiveAccountControlRetryLimits,
} from "./live-account-control.types.js";
import type { WorkflowError } from "./trading-cycle.types.js";

const DEFAULT_RETRY_LIMITS: LiveAccountControlRetryLimits = {
  cancellation: 3,
  reconciliation: 4,
  flatten: 2,
  verification: 4,
};

const emptyAttempts = (): LiveAccountControlAttempts => ({
  cancellation: 0,
  reconciliation: 0,
  flatten: 0,
  verification: 0,
});

const reconciliationFailure = (): WorkflowError => ({
  phase: "reconciliation",
  code: "RECONCILIATION_FAILURE",
  retryable: true,
});

const invalidAccountFailure = (): WorkflowError => ({
  phase: "reconciliation",
  code: "INVALID_RESPONSE",
  retryable: false,
});

const flattenFailure = (): WorkflowError => ({
  phase: "execution",
  code: "ORDER_REJECTED",
  retryable: false,
});

const validAccountEvent = (
  event: LiveAccountControlEvent,
): event is Extract<LiveAccountControlEvent, { type: "ACCOUNT_RECONCILED" }> =>
  event.type === "ACCOUNT_RECONCILED" &&
  event.snapshotId.trim().length > 0 &&
  Number.isFinite(event.totalBaseQuantity) &&
  event.totalBaseQuantity >= 0 &&
  Number.isFinite(event.availableBaseQuantity) &&
  event.availableBaseQuantity >= 0 &&
  Number.isFinite(event.dustQuantity) &&
  event.dustQuantity > 0 &&
  Number.isSafeInteger(event.openOrderCount) &&
  event.openOrderCount >= 0 &&
  event.availableBaseQuantity <=
    event.totalBaseQuantity + event.dustQuantity;

const recordAccount = (
  event: Extract<LiveAccountControlEvent, { type: "ACCOUNT_RECONCILED" }>,
) => ({
  snapshotId: event.snapshotId,
  totalBaseQuantity: event.totalBaseQuantity,
  availableBaseQuantity: event.availableBaseQuantity,
  dustQuantity: event.dustQuantity,
  openOrderCount: event.openOrderCount,
});

export const liveAccountControlMachine = setup({
  types: {
    context: {} as LiveAccountControlContext,
    events: {} as LiveAccountControlEvent,
    input: {} as LiveAccountControlInput,
  },
  guards: {
    canStartKill: ({ event }) =>
      event.type === "KILL_REQUESTED" &&
      event.permissions.canControl &&
      event.productId.trim().length > 0 &&
      event.flattenClientOrderPrefix.trim().length > 0,
    accountIsInvalid: ({ event }) =>
      event.type === "ACCOUNT_RECONCILED" && !validAccountEvent(event),
    accountHasOpenOrders: ({ event }) =>
      validAccountEvent(event) && event.openOrderCount > 0,
    accountIsFlat: ({ event }) =>
      validAccountEvent(event) &&
      event.openOrderCount === 0 &&
      event.totalBaseQuantity <= event.dustQuantity,
    accountCanBeFlattened: ({ context, event }) =>
      validAccountEvent(event) &&
      event.openOrderCount === 0 &&
      event.totalBaseQuantity > event.dustQuantity &&
      event.availableBaseQuantity > event.dustQuantity &&
      event.totalBaseQuantity - event.availableBaseQuantity <=
        event.dustQuantity &&
      context.attempts.flatten < context.retryLimits.flatten &&
      !context.flattenOutcomeUnknown,
    accountHasHeldQuantity: ({ event }) =>
      validAccountEvent(event) &&
      event.openOrderCount === 0 &&
      event.totalBaseQuantity > event.dustQuantity &&
      (event.availableBaseQuantity <= event.dustQuantity ||
        event.totalBaseQuantity - event.availableBaseQuantity >
          event.dustQuantity),
    canRetryHeldReconciliation: ({ context, event }) =>
      validAccountEvent(event) &&
      event.openOrderCount === 0 &&
      event.totalBaseQuantity > event.dustQuantity &&
      (event.availableBaseQuantity <= event.dustQuantity ||
        event.totalBaseQuantity - event.availableBaseQuantity >
          event.dustQuantity) &&
      context.attempts.reconciliation < context.retryLimits.reconciliation,
    canRetryHeldVerification: ({ context, event }) =>
      validAccountEvent(event) &&
      event.openOrderCount === 0 &&
      event.totalBaseQuantity > event.dustQuantity &&
      (event.availableBaseQuantity <= event.dustQuantity ||
        event.totalBaseQuantity - event.availableBaseQuantity >
          event.dustQuantity) &&
      context.attempts.verification < context.retryLimits.verification,
    canRetryCancellationFailure: ({ context, event }) =>
      event.type === "OPERATION_FAILED" &&
      event.error.phase === "cancellation" &&
      event.error.retryable &&
      context.attempts.cancellation < context.retryLimits.cancellation,
    canRetryReconciliationFailure: ({ context, event }) =>
      event.type === "OPERATION_FAILED" &&
      event.error.phase === "reconciliation" &&
      event.error.retryable &&
      context.attempts.reconciliation < context.retryLimits.reconciliation,
    canRetryVerificationFailure: ({ context, event }) =>
      event.type === "OPERATION_FAILED" &&
      event.error.phase === "reconciliation" &&
      event.error.retryable &&
      context.attempts.verification < context.retryLimits.verification,
    canRetryFlattenRejection: ({ context, event }) =>
      event.type === "FLATTEN_REJECTED" &&
      event.error.retryable &&
      context.attempts.flatten < context.retryLimits.flatten,
  },
  actions: {
    recordKillRequest: assign(({ event }) =>
      event.type === "KILL_REQUESTED"
        ? {
            productId: event.productId,
            flattenClientOrderPrefix: event.flattenClientOrderPrefix,
            permissions: event.permissions,
            lastError: null,
            attempts: emptyAttempts(),
          }
        : {},
    ),
    recordKillDenied: assign(({ event }) => ({
      lastError: {
        phase: "cancellation" as const,
        code:
          event.type === "KILL_REQUESTED" && !event.permissions.canControl
            ? ("CONTROL_PERMISSION_REQUIRED" as const)
            : ("INVALID_RESPONSE" as const),
        retryable: false,
      },
    })),
    recordAccount: assign(({ event }) =>
      validAccountEvent(event) ? recordAccount(event) : {},
    ),
    recordInvalidAccount: assign({ lastError: invalidAccountFailure() }),
    prepareFlatten: assign(({ context, event }) =>
      validAccountEvent(event)
        ? {
            ...recordAccount(event),
            flattenQuantity: event.availableBaseQuantity,
            attempts: {
              ...context.attempts,
              flatten: context.attempts.flatten + 1,
            },
            flattenOutcomeUnknown: false,
          }
        : {},
    ),
    recordHeldReconciliation: assign(({ context, event }) =>
      validAccountEvent(event)
        ? {
            ...recordAccount(event),
            lastError: reconciliationFailure(),
            attempts: {
              ...context.attempts,
              reconciliation: context.attempts.reconciliation + 1,
            },
          }
        : {},
    ),
    recordHeldVerification: assign(({ context, event }) =>
      validAccountEvent(event)
        ? {
            ...recordAccount(event),
            lastError: reconciliationFailure(),
            attempts: {
              ...context.attempts,
              verification: context.attempts.verification + 1,
            },
          }
        : {},
    ),
    recordHeldExhausted: assign(({ event }) => ({
      ...(validAccountEvent(event) ? recordAccount(event) : {}),
      lastError: { ...reconciliationFailure(), retryable: false },
    })),
    recordUnflattenableAccount: assign(({ context, event }) => ({
      ...(validAccountEvent(event) ? recordAccount(event) : {}),
      lastError: context.flattenOutcomeUnknown
        ? {
            phase: "execution" as const,
            code: "ORDER_OUTCOME_UNKNOWN" as const,
            retryable: false,
          }
        : flattenFailure(),
    })),
    markFlattenConfirmed: assign({ flattenOutcomeUnknown: false }),
    markFlattenUnknown: assign({ flattenOutcomeUnknown: true }),
    recordOperationError: assign(({ event }) => ({
      lastError:
        event.type === "OPERATION_FAILED" ||
        event.type === "FLATTEN_REJECTED"
          ? event.error
          : invalidAccountFailure(),
    })),
    incrementCancellationAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        cancellation: context.attempts.cancellation + 1,
      },
    })),
    incrementReconciliationAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        reconciliation: context.attempts.reconciliation + 1,
      },
    })),
    incrementVerificationAttempt: assign(({ context }) => ({
      attempts: {
        ...context.attempts,
        verification: context.attempts.verification + 1,
      },
    })),
  },
}).createMachine({
  id: "liveAccountControl",
  context: ({ input }) => ({
    productId: null,
    flattenClientOrderPrefix: null,
    permissions: { canControl: false, canTrade: false },
    snapshotId: null,
    totalBaseQuantity: null,
    availableBaseQuantity: null,
    dustQuantity: null,
    openOrderCount: null,
    flattenQuantity: null,
    flattenOutcomeUnknown: false,
    lastError: null,
    retryLimits: { ...DEFAULT_RETRY_LIMITS, ...input?.retryLimits },
    attempts: emptyAttempts(),
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        KILL_REQUESTED: [
          {
            guard: "canStartKill",
            target: "cancellingOrders",
            actions: "recordKillRequest",
          },
          { target: "failed", actions: "recordKillDenied" },
        ],
      },
    },
    cancellingOrders: {
      on: {
        ORDERS_CLEARED: "reconcilingPosition",
        OPERATION_FAILED: [
          {
            guard: "canRetryCancellationFailure",
            target: "retryingCancellation",
            actions: ["recordOperationError", "incrementCancellationAttempt"],
          },
          { target: "failed", actions: "recordOperationError" },
        ],
      },
    },
    retryingCancellation: {
      on: { RETRY_TIMER_ELAPSED: "cancellingOrders" },
    },
    reconcilingPosition: {
      on: {
        ACCOUNT_RECONCILED: [
          {
            guard: "accountIsInvalid",
            target: "failed",
            actions: "recordInvalidAccount",
          },
          {
            guard: "accountHasOpenOrders",
            target: "cancellingOrders",
            actions: "recordAccount",
          },
          {
            guard: "accountIsFlat",
            target: "completed",
            actions: "recordAccount",
          },
          {
            guard: "accountCanBeFlattened",
            target: "flatteningPosition",
            actions: "prepareFlatten",
          },
          {
            guard: "canRetryHeldReconciliation",
            target: "retryingReconciliation",
            actions: "recordHeldReconciliation",
          },
          {
            guard: "accountHasHeldQuantity",
            target: "failed",
            actions: "recordHeldExhausted",
          },
          { target: "failed", actions: "recordUnflattenableAccount" },
        ],
        OPERATION_FAILED: [
          {
            guard: "canRetryReconciliationFailure",
            target: "retryingReconciliation",
            actions: ["recordOperationError", "incrementReconciliationAttempt"],
          },
          { target: "failed", actions: "recordOperationError" },
        ],
      },
    },
    retryingReconciliation: {
      on: { RETRY_TIMER_ELAPSED: "reconcilingPosition" },
    },
    flatteningPosition: {
      on: {
        FLATTEN_CONFIRMED: {
          target: "verifyingFlat",
          actions: "markFlattenConfirmed",
        },
        FLATTEN_OUTCOME_UNKNOWN: {
          target: "verifyingFlat",
          actions: "markFlattenUnknown",
        },
        FLATTEN_REJECTED: [
          {
            guard: "canRetryFlattenRejection",
            target: "reconcilingPosition",
            actions: "recordOperationError",
          },
          { target: "failed", actions: "recordOperationError" },
        ],
      },
    },
    verifyingFlat: {
      on: {
        ACCOUNT_RECONCILED: [
          {
            guard: "accountIsInvalid",
            target: "failed",
            actions: "recordInvalidAccount",
          },
          {
            guard: "accountHasOpenOrders",
            target: "cancellingOrders",
            actions: "recordAccount",
          },
          {
            guard: "accountIsFlat",
            target: "completed",
            actions: "recordAccount",
          },
          {
            guard: "accountCanBeFlattened",
            target: "flatteningPosition",
            actions: "prepareFlatten",
          },
          {
            guard: "canRetryHeldVerification",
            target: "retryingVerification",
            actions: "recordHeldVerification",
          },
          {
            guard: "accountHasHeldQuantity",
            target: "failed",
            actions: "recordHeldExhausted",
          },
          { target: "failed", actions: "recordUnflattenableAccount" },
        ],
        OPERATION_FAILED: [
          {
            guard: "canRetryVerificationFailure",
            target: "retryingVerification",
            actions: ["recordOperationError", "incrementVerificationAttempt"],
          },
          { target: "failed", actions: "recordOperationError" },
        ],
      },
    },
    retryingVerification: {
      on: { RETRY_TIMER_ELAPSED: "verifyingFlat" },
    },
    completed: { type: "final" },
    failed: { type: "final" },
  },
});
