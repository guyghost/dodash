import { assign, setup } from "xstate";

import type {
  LiveSellProtectionContext,
  LiveSellProtectionEvent,
  LiveSellProtectionInput,
} from "./live-sell-protection.types.js";

const fallbackError = {
  phase: "reconciliation" as const,
  code: "INVALID_RESPONSE" as const,
  retryable: false,
};

const validAccount = (
  event: LiveSellProtectionEvent,
): event is Extract<LiveSellProtectionEvent, { type: "ACCOUNT_RECONCILED" }> =>
  event.type === "ACCOUNT_RECONCILED" &&
  event.snapshotId.trim().length > 0 &&
  Number.isFinite(event.totalBaseQuantity) &&
  event.totalBaseQuantity >= 0 &&
  Number.isFinite(event.availableBaseQuantity) &&
  event.availableBaseQuantity >= 0 &&
  Number.isFinite(event.averageEntryPrice) &&
  event.averageEntryPrice >= 0 &&
  Number.isFinite(event.dustQuantity) &&
  event.dustQuantity > 0 &&
  event.availableBaseQuantity <= event.totalBaseQuantity + event.dustQuantity;

const accountFields = (
  event: Extract<LiveSellProtectionEvent, { type: "ACCOUNT_RECONCILED" }>,
) => ({
  snapshotId: event.snapshotId,
  totalBaseQuantity: event.totalBaseQuantity,
  availableBaseQuantity: event.availableBaseQuantity,
  averageEntryPrice: event.averageEntryPrice,
  dustQuantity: event.dustQuantity,
});

export const liveSellProtectionMachine = setup({
  types: {
    context: {} as LiveSellProtectionContext,
    events: {} as LiveSellProtectionEvent,
    input: {} as LiveSellProtectionInput,
  },
  guards: {
    validRequest: ({ event }) =>
      event.type === "SELL_REQUESTED" &&
      event.permissions.canControl &&
      event.permissions.canTrade &&
      event.productId.trim().length > 0 &&
      event.clientOrderId.trim().length > 0 &&
      Number.isFinite(event.quantity) &&
      event.quantity > 0,
    invalidAccount: ({ event }) =>
      event.type === "ACCOUNT_RECONCILED" && !validAccount(event),
    accountIsFlat: ({ event }) =>
      validAccount(event) && event.totalBaseQuantity <= event.dustQuantity,
    accountCanSellRequestedQuantity: ({ context, event }) =>
      validAccount(event) &&
      context.requestedQuantity !== null &&
      event.totalBaseQuantity > event.dustQuantity &&
      event.totalBaseQuantity + event.dustQuantity >= context.requestedQuantity &&
      event.availableBaseQuantity + event.dustQuantity >= context.requestedQuantity &&
      event.totalBaseQuantity - event.availableBaseQuantity <= event.dustQuantity,
    residualCanBeProtected: ({ event }) =>
      validAccount(event) &&
      event.totalBaseQuantity > event.dustQuantity &&
      event.averageEntryPrice > 0 &&
      event.availableBaseQuantity > event.dustQuantity &&
      event.totalBaseQuantity - event.availableBaseQuantity <= event.dustQuantity,
  },
  actions: {
    recordRequest: assign(({ event }) =>
      event.type === "SELL_REQUESTED"
        ? {
            productId: event.productId,
            clientOrderId: event.clientOrderId,
            requestedQuantity: event.quantity,
            permissions: event.permissions,
            outcome: "IDLE" as const,
            lastError: null,
          }
        : {},
    ),
    recordRequestFailure: assign({
      outcome: "FAILED",
      lastError: {
        phase: "authorization",
        code: "TRADE_PERMISSION_REQUIRED",
        retryable: false,
      },
    }),
    recordAccount: assign(({ event }) =>
      validAccount(event) ? accountFields(event) : {},
    ),
    recordNoSellNeeded: assign(({ event }) => ({
      ...(validAccount(event) ? accountFields(event) : {}),
      outcome: "NO_SELL_NEEDED" as const,
    })),
    recordInvalidAccount: assign({ lastError: fallbackError }),
    recordSellOrder: assign(({ event }) =>
      event.type === "SELL_ACKNOWLEDGED" ||
      event.type === "SELL_CONFIRMED" ||
      event.type === "SELL_OUTCOME_UNKNOWN"
        ? { exchangeOrderId: event.exchangeOrderId }
        : {},
    ),
    recordOperationFailure: assign(({ event }) => ({
      lastError:
        event.type === "OPERATION_FAILED" ||
        event.type === "SELL_REJECTED" ||
        event.type === "SAFETY_FLATTEN_FAILED"
          ? event.error
          : fallbackError,
    })),
    recordProtection: assign(({ event }) =>
      event.type === "PROTECTION_ACKNOWLEDGED"
        ? { protectiveOrderId: event.protectiveOrderId }
        : {},
    ),
    markSoldFlat: assign({ outcome: "SOLD_FLAT" }),
    markSoldReprotected: assign({ outcome: "SOLD_REPROTECTED" }),
    markFlattenedAfterFailure: assign({
      outcome: "FLATTENED_AFTER_FAILURE",
    }),
    markFailed: assign({ outcome: "FAILED" }),
  },
}).createMachine({
  id: "liveSellProtection",
  context: {
    productId: null,
    clientOrderId: null,
    requestedQuantity: null,
    permissions: { canControl: false, canTrade: false },
    snapshotId: null,
    totalBaseQuantity: null,
    availableBaseQuantity: null,
    averageEntryPrice: null,
    dustQuantity: null,
    exchangeOrderId: null,
    protectiveOrderId: null,
    outcome: "IDLE",
    lastError: null,
  },
  initial: "idle",
  states: {
    idle: {
      on: {
        SELL_REQUESTED: [
          {
            guard: "validRequest",
            target: "cancellingProtections",
            actions: "recordRequest",
          },
          { target: "failed", actions: ["recordRequest", "recordRequestFailure"] },
        ],
      },
    },
    cancellingProtections: {
      on: {
        PROTECTIONS_CLEARED: "reconcilingBeforeSell",
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    reconcilingBeforeSell: {
      on: {
        ACCOUNT_RECONCILED: [
          {
            guard: "invalidAccount",
            target: "safetyFlattening",
            actions: "recordInvalidAccount",
          },
          {
            guard: "accountIsFlat",
            target: "completed",
            actions: "recordNoSellNeeded",
          },
          {
            guard: "accountCanSellRequestedQuantity",
            target: "submittingSell",
            actions: "recordAccount",
          },
          {
            target: "safetyFlattening",
            actions: ["recordAccount", "recordInvalidAccount"],
          },
        ],
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    submittingSell: {
      on: {
        SELL_CONFIRMED: {
          target: "reconcilingResidual",
          actions: "recordSellOrder",
        },
        SELL_ACKNOWLEDGED: {
          target: "reconcilingSell",
          actions: "recordSellOrder",
        },
        SELL_OUTCOME_UNKNOWN: {
          target: "reconcilingSell",
          actions: "recordSellOrder",
        },
        SELL_REJECTED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    reconcilingSell: {
      on: {
        SELL_CONFIRMED: {
          target: "reconcilingResidual",
          actions: "recordSellOrder",
        },
        SELL_REJECTED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    reconcilingResidual: {
      on: {
        ACCOUNT_RECONCILED: [
          {
            guard: "invalidAccount",
            target: "safetyFlattening",
            actions: "recordInvalidAccount",
          },
          {
            guard: "accountIsFlat",
            target: "completed",
            actions: ["recordAccount", "markSoldFlat"],
          },
          {
            guard: "residualCanBeProtected",
            target: "armingResidual",
            actions: "recordAccount",
          },
          {
            target: "safetyFlattening",
            actions: ["recordAccount", "recordInvalidAccount"],
          },
        ],
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    armingResidual: {
      on: {
        PROTECTION_ACKNOWLEDGED: {
          target: "confirmingResidualProtection",
          actions: "recordProtection",
        },
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    confirmingResidualProtection: {
      on: {
        PROTECTION_CONFIRMED: {
          target: "completed",
          actions: "markSoldReprotected",
        },
        OPERATION_FAILED: {
          target: "safetyFlattening",
          actions: "recordOperationFailure",
        },
      },
    },
    safetyFlattening: {
      on: {
        SAFETY_FLATTEN_SUCCEEDED: {
          target: "safetyCompleted",
          actions: "markFlattenedAfterFailure",
        },
        SAFETY_FLATTEN_FAILED: {
          target: "failed",
          actions: ["recordOperationFailure", "markFailed"],
        },
      },
    },
    completed: { type: "final" },
    safetyCompleted: { type: "final" },
    failed: { type: "final" },
  },
});
