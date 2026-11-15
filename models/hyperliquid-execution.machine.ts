import { assign, setup } from "xstate";

import { assessPerpOrderIntent, isWellFormedPerpIntent } from "./hyperliquid-execution.js";
import type {
  HyperliquidPerpOrderContext,
  HyperliquidPerpOrderEvent,
  HyperliquidPerpOrderInput,
  PerpRefusalCode,
} from "./hyperliquid-execution.types.js";

const CLIENT_ORDER_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Machine d'exécution d'un ordre perp Hyperliquid. Elle reprend la patte
 * d'ordre du cycle de trading : l'intention est persistée (clientOrderId)
 * avant tout effet réseau, la signature EIP-712 est un effet du shell,
 * une issue inconnue déclenche une réconciliation et jamais un retry
 * aveugle. Source de vérité : models/hyperliquid-execution.md.
 */
export const hyperliquidPerpOrderMachine = setup({
  types: {
    context: {} as HyperliquidPerpOrderContext,
    events: {} as HyperliquidPerpOrderEvent,
    input: {} as HyperliquidPerpOrderInput,
  },
  guards: {
    executableIntent: ({ event }) =>
      event.type === "ORDER_INTENT_REQUESTED" &&
      event.signerReady &&
      CLIENT_ORDER_ID_PATTERN.test(event.clientOrderId) &&
      assessPerpOrderIntent(event.intent, event.gate).status === "EXECUTABLE",
    validRecoveryPayload: ({ event }) =>
      event.type === "ORDER_RECOVERY_REQUESTED" &&
      CLIENT_ORDER_ID_PATTERN.test(event.clientOrderId) &&
      isWellFormedPerpIntent(event.intent),
  },
  actions: {
    recordIntent: assign(({ event }) => {
      if (event.type === "ORDER_INTENT_REQUESTED") {
        return {
          intent: Object.freeze(event.intent),
          clientOrderId: event.clientOrderId,
          lastRefusal: null,
          lastError: null,
          outcome: null,
        };
      }
      if (event.type === "ORDER_RECOVERY_REQUESTED") {
        return {
          intent: Object.freeze(event.intent),
          clientOrderId: event.clientOrderId,
          lastRefusal: null,
          lastError: null,
          outcome: null,
        };
      }
      return {};
    }),
    recordRefusal: assign(({ event }) => {
      if (event.type !== "ORDER_INTENT_REQUESTED") return {};
      let lastRefusal: PerpRefusalCode = "PERP_INTENT_INVALID";
      if (!event.signerReady) {
        lastRefusal = "AGENT_WALLET_NOT_READY";
      } else {
        const assessment = assessPerpOrderIntent(event.intent, event.gate);
        if (assessment.status === "REFUSED") lastRefusal = assessment.reasonCode;
      }
      return {
        intent: null,
        clientOrderId: null,
        outcome: null,
        lastRefusal,
        lastError: null,
      };
    }),
    recordOutcome: assign(({ event }) => {
      if (event.type === "SUBMIT_ACCEPTED") {
        return { outcome: "ACCEPTED" as const, lastError: null };
      }
      if (event.type === "SUBMIT_REJECTED") {
        return { outcome: "REJECTED" as const, lastError: null };
      }
      if (event.type === "RECONCILIATION_RESOLVED") {
        return { outcome: event.outcome, lastError: null };
      }
      return {};
    }),
    recordError: assign(({ event }) =>
      event.type === "INTENT_PERSIST_FAILED" ||
      event.type === "SIGN_FAILED" ||
      event.type === "RECONCILIATION_FAILED" ||
      event.type === "PERSIST_FAILED"
        ? { lastError: event.error }
        : {},
    ),
    clearOrder: assign({
      clientOrderId: null,
      intent: null,
      outcome: null,
      lastRefusal: null,
      lastError: null,
    }),
  },
}).createMachine({
  id: "hyperliquidPerpOrder",
  context: () => ({
    clientOrderId: null,
    intent: null,
    outcome: null,
    lastRefusal: null,
    lastError: null,
  }),
  initial: "idle",
  on: {
    RESET: { target: ".idle", actions: "clearOrder" },
  },
  states: {
    idle: {
      on: {
        ORDER_INTENT_REQUESTED: [
          {
            guard: "executableIntent",
            target: "persistingIntent",
            actions: "recordIntent",
          },
          { actions: "recordRefusal" },
        ],
        ORDER_RECOVERY_REQUESTED: [
          {
            guard: "validRecoveryPayload",
            target: "reconciling",
            actions: "recordIntent",
          },
          { actions: "recordRefusal" },
        ],
      },
    },
    persistingIntent: {
      on: {
        INTENT_PERSIST_SUCCEEDED: { target: "signing" },
        INTENT_PERSIST_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    signing: {
      on: {
        ACTION_SIGNED: { target: "submitting" },
        SIGN_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    submitting: {
      on: {
        SUBMIT_ACCEPTED: { target: "persistingOutcome", actions: "recordOutcome" },
        SUBMIT_REJECTED: { target: "persistingOutcome", actions: "recordOutcome" },
        SUBMIT_UNKNOWN: { target: "reconciling" },
      },
    },
    reconciling: {
      on: {
        RECONCILIATION_RESOLVED: {
          target: "persistingOutcome",
          actions: "recordOutcome",
        },
        RECONCILIATION_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    persistingOutcome: {
      on: {
        PERSIST_SUCCEEDED: { target: "settled" },
        PERSIST_FAILED: { target: "failed", actions: "recordError" },
      },
    },
    settled: {
      on: {
        RESET: { target: "idle", actions: "clearOrder" },
      },
    },
    failed: {
      on: {
        RESET: { target: "idle", actions: "clearOrder" },
      },
    },
  },
});
