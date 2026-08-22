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
  RegimeFilterPolicy,
  RegimeKind,
} from "./regime-filter.types.js";

const rawKind = (
  context: RegimeFilterContext,
  event: RegimeFilterEvent,
): RegimeKind | null =>
  event.type === "CANDLE_CLOSED" &&
  isValidRegimeObservation(event.observation, context.lastObservationStart)
    ? classifyRegimeObservation(
        context.policy,
        event.observation,
        context.emaSlowHistory,
      )
    : null;

/** Taille max de l'historique EMA slow selon le mode (0 hors EMA_SLOPE). */
const historyCap = (policy: RegimeFilterPolicy): number =>
  policy.mode === "EMA_SLOPE" ? policy.slopePeriods : 0;

/**
 * Historique après intégration de l'EMA slow de l'observation courante
 * (R1 : indépendant du résultat de classification ; R4 : borne stricte).
 */
const appendedHistory = (
  context: RegimeFilterContext,
  event: RegimeFilterEvent,
): readonly number[] => {
  if (event.type !== "CANDLE_CLOSED") return context.emaSlowHistory;
  const cap = historyCap(context.policy);
  if (cap === 0) return context.emaSlowHistory;
  return [...context.emaSlowHistory, event.observation.emaSlow].slice(-cap);
};

const warmedUp = (context: RegimeFilterContext, raw: RegimeKind): boolean => {
  const streak = context.pendingKind === raw ? context.pendingCount + 1 : 1;
  return (
    context.observationCount + 1 >= context.policy.minObservations &&
    streak >= context.policy.confirmationCount
  );
};

const opposingStreak = (context: RegimeFilterContext, raw: RegimeKind): number =>
  context.opposingKind === raw ? context.opposingCount + 1 : 1;

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
      if (event.type !== "CANDLE_CLOSED") return {};
      // Base commune : comptée et historisée même si la classification est
      // pending (R1). Les streaks de confirmation ne sont touchés que sur
      // classification effective (R2 : le pending ne casse ni n'étend un
      // streak en cours).
      const base = {
        observationCount: context.observationCount + 1,
        lastObservationStart: event.observation.start,
        emaSlowHistory: appendedHistory(context, event),
      };
      const raw = rawKind(context, event);
      if (raw === null) return base;
      return {
        ...base,
        pendingKind: raw,
        pendingCount:
          context.pendingKind === raw ? context.pendingCount + 1 : 1,
      };
    }),
    recordRegimeObservation: assign(({ context, event }) => {
      if (event.type !== "CANDLE_CLOSED" || context.regime === null) return {};
      const base = {
        observationCount: context.observationCount + 1,
        lastObservationStart: event.observation.start,
        emaSlowHistory: appendedHistory(context, event),
      };
      const raw = rawKind(context, event);
      // Défensif : post-warm-up la classification n'est jamais pending (R3),
      // l'historique est saturé dès la première entrée de régime.
      if (raw === null) return base;
      if (raw === context.regime) {
        return { ...base, opposingKind: null, opposingCount: 0 };
      }
      return {
        ...base,
        opposingKind: raw,
        opposingCount: opposingStreak(context, raw),
      };
    }),
    recordRegimeEntry: assign(({ context, event }) => {
      if (event.type !== "CANDLE_CLOSED") return {};
      const base = {
        observationCount: context.observationCount + 1,
        lastObservationStart: event.observation.start,
        emaSlowHistory: appendedHistory(context, event),
      };
      const raw = rawKind(context, event);
      // Défensif : les gardes d'entrée exigent une classification effective.
      if (raw === null) return base;
      return {
        ...base,
        regime: raw,
        pendingKind: null,
        pendingCount: 0,
        opposingKind: null,
        opposingCount: 0,
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
    emaSlowHistory: [],
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
