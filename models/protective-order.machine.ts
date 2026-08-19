import { assign, setup } from "xstate";

import {
  createProtectiveOrderPlan,
  resolveProtectiveOpen,
  resolveProtectiveRange,
} from "./protective-order.js";
import type {
  ProtectiveExitResolution,
  ProtectiveOrderContext,
  ProtectiveOrderEvent,
  ProtectiveOrderInput,
} from "./protective-order.types.js";

const planFromEvent = (
  context: ProtectiveOrderContext,
  event: ProtectiveOrderEvent,
) => {
  if (event.type === "ARM_REQUESTED") {
    return createProtectiveOrderPlan({
      positionId: event.positionId,
      quantity: event.quantity,
      averageEntryPrice: event.averageEntryPrice,
      atr: event.atr,
      armedAt: event.armedAt,
      policy: context.policy,
    });
  }
  if (event.type === "POSITION_INCREASED" && context.plan !== null) {
    return createProtectiveOrderPlan({
      positionId: context.plan.positionId,
      quantity: event.quantity,
      averageEntryPrice: event.averageEntryPrice,
      atr: event.atr,
      armedAt: event.updatedAt,
      policy: context.policy,
    });
  }
  return null;
};

const openResolution = (
  context: ProtectiveOrderContext,
  event: ProtectiveOrderEvent,
) =>
  event.type === "CANDLE_OPENED" && context.plan !== null
    ? resolveProtectiveOpen(context.plan, event)
    : null;

const rangeResolution = (
  context: ProtectiveOrderContext,
  event: ProtectiveOrderEvent,
) =>
  event.type === "CANDLE_RANGE_REPLAYED" && context.plan !== null
    ? resolveProtectiveRange(context.plan, event)
    : null;

const triggeredResolution = (
  resolution: ReturnType<typeof resolveProtectiveOpen> | null,
): ProtectiveExitResolution | null =>
  resolution?.ok && resolution.value.status === "TRIGGERED"
    ? resolution.value
    : null;

export const protectiveOrderMachine = setup({
  types: {
    context: {} as ProtectiveOrderContext,
    events: {} as ProtectiveOrderEvent,
    input: {} as ProtectiveOrderInput,
  },
  guards: {
    canArm: ({ context, event }) => planFromEvent(context, event)?.ok === true,
    canIncrease: ({ context, event }) =>
      event.type === "POSITION_INCREASED" &&
      context.plan !== null &&
      event.quantity > context.plan.quantity &&
      planFromEvent(context, event)?.ok === true &&
      (context.currentCandleStart === null ||
        event.updatedAt === context.currentCandleStart),
    canReduce: ({ context, event }) =>
      event.type === "POSITION_REDUCED" &&
      context.plan !== null &&
      Number.isFinite(event.quantity) &&
      event.quantity > 0 &&
      event.quantity < context.plan.quantity &&
      event.updatedAt >= context.plan.armedAt &&
      (context.currentCandleStart === null ||
        event.updatedAt === context.currentCandleStart),
    openTriggers: ({ context, event }) =>
      event.type === "CANDLE_OPENED" &&
      context.plan !== null &&
      (context.lastCandleStart === null || event.start > context.lastCandleStart) &&
      triggeredResolution(openResolution(context, event)) !== null,
    validOpenWithoutTrigger: ({ context, event }) => {
      if (
        event.type !== "CANDLE_OPENED" ||
        context.plan === null ||
        (context.lastCandleStart !== null && event.start <= context.lastCandleStart)
      ) {
        return false;
      }
      const result = openResolution(context, event);
      return result?.ok === true && result.value.status === "NOT_TRIGGERED";
    },
    rangeTriggers: ({ context, event }) =>
      event.type === "CANDLE_RANGE_REPLAYED" &&
      context.plan !== null &&
      context.currentCandleStart === event.start &&
      context.currentOpen !== null &&
      event.low <= context.currentOpen &&
      event.high >= context.currentOpen &&
      triggeredResolution(rangeResolution(context, event)) !== null,
    validRangeWithoutTrigger: ({ context, event }) => {
      if (
        event.type !== "CANDLE_RANGE_REPLAYED" ||
        context.plan === null ||
        context.currentCandleStart !== event.start ||
        context.currentOpen === null ||
        event.low > context.currentOpen ||
        event.high < context.currentOpen
      ) {
        return false;
      }
      const result = rangeResolution(context, event);
      return result?.ok === true && result.value.status === "NOT_TRIGGERED";
    },
  },
  actions: {
    recordPlan: assign(({ context, event }) => {
      const result = planFromEvent(context, event);
      return result?.ok
        ? {
            plan: result.value,
            resolution: null,
            cancelReason: null,
            lastError: null,
          }
        : {};
    }),
    reducePlan: assign(({ context, event }) =>
      event.type === "POSITION_REDUCED" && context.plan !== null
        ? { plan: Object.freeze({ ...context.plan, quantity: event.quantity }) }
        : {},
    ),
    recordOpen: assign(({ event }) =>
      event.type === "CANDLE_OPENED"
        ? { currentCandleStart: event.start, currentOpen: event.open }
        : {},
    ),
    recordOpenTrigger: assign(({ context, event }) => ({
      resolution: triggeredResolution(openResolution(context, event)),
      lastCandleStart: event.type === "CANDLE_OPENED" ? event.start : null,
      currentCandleStart: null,
      currentOpen: null,
    })),
    recordRangeTrigger: assign(({ context, event }) => ({
      resolution: triggeredResolution(rangeResolution(context, event)),
      lastCandleStart:
        event.type === "CANDLE_RANGE_REPLAYED" ? event.start : null,
      currentCandleStart: null,
      currentOpen: null,
    })),
    completeRange: assign(({ event }) => ({
      lastCandleStart:
        event.type === "CANDLE_RANGE_REPLAYED" ? event.start : null,
      currentCandleStart: null,
      currentOpen: null,
    })),
    recordCancel: assign(({ event }) =>
      event.type === "CANCEL_REQUESTED" ? { cancelReason: event.reason } : {},
    ),
    recordInvalidPlan: assign({
      lastError: { code: "INVALID_PROTECTIVE_PLAN" },
    }),
    recordInvalidSequence: assign({
      lastError: { code: "INVALID_PROTECTIVE_SEQUENCE" },
    }),
  },
}).createMachine({
  id: "protectiveOrder",
  context: ({ input }) => ({
    policy: input.policy,
    plan: null,
    currentCandleStart: null,
    currentOpen: null,
    lastCandleStart: null,
    resolution: null,
    cancelReason: null,
    lastError: null,
  }),
  initial: "idle",
  states: {
    idle: {
      on: {
        ARM_REQUESTED: [
          { guard: "canArm", target: "armed", actions: "recordPlan" },
          { target: "failed", actions: "recordInvalidPlan" },
        ],
        CANDLE_OPENED: { target: "failed", actions: "recordInvalidSequence" },
        CANDLE_RANGE_REPLAYED: {
          target: "failed",
          actions: "recordInvalidSequence",
        },
      },
    },
    armed: {
      initial: "awaitingOpen",
      on: {
        CANCEL_REQUESTED: { target: "cancelled", actions: "recordCancel" },
      },
      states: {
        awaitingOpen: {
          on: {
            POSITION_INCREASED: [
              { guard: "canIncrease", actions: "recordPlan" },
              { target: "#protectiveOrder.failed", actions: "recordInvalidPlan" },
            ],
            POSITION_REDUCED: [
              { guard: "canReduce", actions: "reducePlan" },
              { target: "#protectiveOrder.failed", actions: "recordInvalidPlan" },
            ],
            CANDLE_OPENED: [
              {
                guard: "openTriggers",
                target: "#protectiveOrder.triggered",
                actions: "recordOpenTrigger",
              },
              {
                guard: "validOpenWithoutTrigger",
                target: "awaitingRange",
                actions: "recordOpen",
              },
              {
                target: "#protectiveOrder.failed",
                actions: "recordInvalidSequence",
              },
            ],
            CANDLE_RANGE_REPLAYED: {
              target: "#protectiveOrder.failed",
              actions: "recordInvalidSequence",
            },
          },
        },
        awaitingRange: {
          on: {
            POSITION_INCREASED: [
              { guard: "canIncrease", actions: "recordPlan" },
              { target: "#protectiveOrder.failed", actions: "recordInvalidPlan" },
            ],
            POSITION_REDUCED: [
              { guard: "canReduce", actions: "reducePlan" },
              { target: "#protectiveOrder.failed", actions: "recordInvalidPlan" },
            ],
            CANDLE_RANGE_REPLAYED: [
              {
                guard: "rangeTriggers",
                target: "#protectiveOrder.triggered",
                actions: "recordRangeTrigger",
              },
              {
                guard: "validRangeWithoutTrigger",
                target: "awaitingOpen",
                actions: "completeRange",
              },
              {
                target: "#protectiveOrder.failed",
                actions: "recordInvalidSequence",
              },
            ],
            CANDLE_OPENED: {
              target: "#protectiveOrder.failed",
              actions: "recordInvalidSequence",
            },
          },
        },
      },
    },
    triggered: { type: "final" },
    cancelled: { type: "final" },
    failed: { type: "final" },
  },
});
