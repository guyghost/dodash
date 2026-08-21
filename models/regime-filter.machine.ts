import { assign, setup } from "xstate";

import {
  classifyRegimeObservation,
  isValidRegimeFilterPolicy,
  isValidRegimeObservation,
} from "./regime-filter.js";
import type {
  RegimeFilterContext,
  RegimeFilterEvent,
  RegimeFilterInput,
  RegimeKind,
} from "./regime-filter.types.js";

const rawKind = (
  context: RegimeFilterContext,
  event: RegimeFilterEvent,
): RegimeKind | null =>
  event.type === "CANDLE_CLOSED" &&
  isValidRegimeObservation(event.observation, context.lastObservationStart)
    ? classifyRegimeObservation(context.policy, event.observation)
    : null;

const warmedUp = (context: RegimeFilterContext, raw: RegimeKind): boolean => {
  const streak = context.pendingKind === raw ? context.pendingCount + 1 : 1;
  return (
    context.observationCount + 1 >= context.policy.minObservations &&
    streak >= context.policy.confirmationCount
  );
};

const opposingStreak = (context: RegimeFilterContext, raw: RegimeKind): number =>
  context.opposingKind === raw ? context.opposingCount + 1 : 1;

const observationStart = (event: RegimeFilterEvent): number | null =>
  event.type === "CANDLE_CLOSED" ? event.observation.start : null;

const isSwitchConfirmed = (
  context: RegimeFilterContext,
  raw: RegimeKind | null,
): boolean =>
  raw !== null &&
  raw !== context.regime &&
  opposingStreak(context, raw) >= context.policy.confirmationCount;

const INVALID_OBSERVATION_TRANSITION = {
  guard: "observationInvalid",
  target: "#regimeFilter.failed",
  actions: "recordInvalidObservation",
} as const;

const VALID_OBSERVATION_TRANSITION = {
  guard: "observationValid",
  actions: "recordRegimeObservation",
} as const;

const UNREACHABLE_INVALID_TRANSITION = {
  target: "#regimeFilter.failed",
  actions: "recordInvalidObservation",
} as const;

export const regimeFilterMachine = setup({
  types: {
    context: {} as RegimeFilterContext,
    events: {} as RegimeFilterEvent,
    input: {} as RegimeFilterInput,
  },
  guards: {
    validPolicy: ({ context }) => isValidRegimeFilterPolicy(context.policy),
    observationValid: ({ context, event }) =>
      event.type === "CANDLE_CLOSED" &&
      isValidRegimeObservation(event.observation, context.lastObservationStart),
    observationInvalid: ({ context, event }) =>
      event.type !== "CANDLE_CLOSED" ||
      !isValidRegimeObservation(event.observation, context.lastObservationStart),
    warmingBullish: ({ context, event }) =>
      rawKind(context, event) === "BULLISH" && warmedUp(context, "BULLISH"),
    warmingBearish: ({ context, event }) =>
      rawKind(context, event) === "BEARISH" && warmedUp(context, "BEARISH"),
    warmingRange: ({ context, event }) =>
      rawKind(context, event) === "RANGE" && warmedUp(context, "RANGE"),
    switchToBullish: ({ context, event }) =>
      isSwitchConfirmed(context, rawKind(context, event)) &&
      rawKind(context, event) === "BULLISH",
    switchToBearish: ({ context, event }) =>
      isSwitchConfirmed(context, rawKind(context, event)) &&
      rawKind(context, event) === "BEARISH",
    switchToRange: ({ context, event }) =>
      isSwitchConfirmed(context, rawKind(context, event)) &&
      rawKind(context, event) === "RANGE",
  },
  actions: {
    recordInvalidPolicy: assign({
      lastError: { code: "INVALID_REGIME_POLICY" },
    }),
    recordInvalidObservation: assign({
      lastError: { code: "INVALID_REGIME_OBSERVATION" },
    }),
    recordWarmingObservation: assign(({ context, event }) => {
      const raw = rawKind(context, event);
      if (raw === null) return {};
      return {
        pendingKind: raw,
        pendingCount:
          context.pendingKind === raw ? context.pendingCount + 1 : 1,
        observationCount: context.observationCount + 1,
        lastObservationStart: observationStart(event),
      };
    }),
    recordRegimeObservation: assign(({ context, event }) => {
      const raw = rawKind(context, event);
      if (raw === null || context.regime === null) return {};
      if (raw === context.regime) {
        return {
          opposingKind: null,
          opposingCount: 0,
          observationCount: context.observationCount + 1,
          lastObservationStart: observationStart(event),
        };
      }
      return {
        opposingKind: raw,
        opposingCount: opposingStreak(context, raw),
        observationCount: context.observationCount + 1,
        lastObservationStart: observationStart(event),
      };
    }),
    recordRegimeEntry: assign(({ context, event }) => {
      const raw = rawKind(context, event);
      if (raw === null) return {};
      return {
        regime: raw,
        pendingKind: null,
        pendingCount: 0,
        opposingKind: null,
        opposingCount: 0,
        observationCount: context.observationCount + 1,
        lastObservationStart: observationStart(event),
      };
    }),
    recordStop: assign(({ event }) =>
      event.type === "STOP_REQUESTED" ? { stopReason: event.reason } : {},
    ),
  },
}).createMachine({
  id: "regimeFilter",
  context: ({ input }) => ({
    policy: input.policy,
    regime: null,
    observationCount: 0,
    pendingKind: null,
    pendingCount: 0,
    opposingKind: null,
    opposingCount: 0,
    lastObservationStart: null,
    lastError: null,
    stopReason: null,
  }),
  initial: "idle",
  states: {
    idle: {
      always: [
        { guard: "validPolicy", target: "warmingUp" },
        { target: "failed", actions: "recordInvalidPolicy" },
      ],
    },
    warmingUp: {
      on: {
        CANDLE_CLOSED: [
          {
            guard: "observationInvalid",
            target: "#regimeFilter.failed",
            actions: "recordInvalidObservation",
          },
          {
            guard: "warmingBullish",
            target: "regimeBullish",
            actions: "recordRegimeEntry",
          },
          {
            guard: "warmingBearish",
            target: "regimeBearish",
            actions: "recordRegimeEntry",
          },
          {
            guard: "warmingRange",
            target: "regimeRange",
            actions: "recordRegimeEntry",
          },
          { guard: "observationValid", actions: "recordWarmingObservation" },
          {
            target: "#regimeFilter.failed",
            actions: "recordInvalidObservation",
          },
        ],
        STOP_REQUESTED: { target: "stopped", actions: "recordStop" },
      },
    },
    regimeBullish: {
      on: {
        CANDLE_CLOSED: [
          INVALID_OBSERVATION_TRANSITION,
          {
            guard: "switchToBearish",
            target: "regimeBearish",
            actions: "recordRegimeEntry",
          },
          {
            guard: "switchToRange",
            target: "regimeRange",
            actions: "recordRegimeEntry",
          },
          VALID_OBSERVATION_TRANSITION,
          UNREACHABLE_INVALID_TRANSITION,
        ],
        STOP_REQUESTED: { target: "stopped", actions: "recordStop" },
      },
      entry: assign({ regime: "BULLISH" as const }),
    },
    regimeBearish: {
      on: {
        CANDLE_CLOSED: [
          INVALID_OBSERVATION_TRANSITION,
          {
            guard: "switchToBullish",
            target: "regimeBullish",
            actions: "recordRegimeEntry",
          },
          {
            guard: "switchToRange",
            target: "regimeRange",
            actions: "recordRegimeEntry",
          },
          VALID_OBSERVATION_TRANSITION,
          UNREACHABLE_INVALID_TRANSITION,
        ],
        STOP_REQUESTED: { target: "stopped", actions: "recordStop" },
      },
      entry: assign({ regime: "BEARISH" as const }),
    },
    regimeRange: {
      on: {
        CANDLE_CLOSED: [
          INVALID_OBSERVATION_TRANSITION,
          {
            guard: "switchToBullish",
            target: "regimeBullish",
            actions: "recordRegimeEntry",
          },
          {
            guard: "switchToBearish",
            target: "regimeBearish",
            actions: "recordRegimeEntry",
          },
          VALID_OBSERVATION_TRANSITION,
          UNREACHABLE_INVALID_TRANSITION,
        ],
        STOP_REQUESTED: { target: "stopped", actions: "recordStop" },
      },
      entry: assign({ regime: "RANGE" as const }),
    },
    stopped: { type: "final" },
    failed: { type: "final" },
  },
});
