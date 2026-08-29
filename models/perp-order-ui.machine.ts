import { assign, setup } from "xstate";

import { HYPERLIQUID_PERP_POLICY } from "./hyperliquid-execution.js";
import type {
  HyperliquidPerpProduct,
} from "./hyperliquid-execution.types.js";
import type {
  PerpOrderFormDraft,
  PerpOrderUiContext,
  PerpOrderUiErrorCode,
  PerpOrderUiEvent,
  PerpOrderUiInput,
  PerpOrderUiPermissions,
} from "./perp-order-ui.types.js";

const CLIENT_ORDER_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

const isAllowedProduct = (
  productId: string,
): productId is HyperliquidPerpProduct =>
  (HYPERLIQUID_PERP_POLICY.products as readonly string[]).includes(productId);

const draftRefusal = (
  draft: PerpOrderFormDraft,
): PerpOrderUiErrorCode | null => {
  if (!isAllowedProduct(draft.productId)) return "PERP_DRAFT_PRODUCT";
  if (draft.side !== "BUY" && draft.side !== "SELL") return "PERP_DRAFT_SIDE";
  if (!Number.isFinite(draft.quantity) || draft.quantity <= 0) {
    return "PERP_DRAFT_QUANTITY";
  }
  if (!Number.isFinite(draft.markPrice) || draft.markPrice <= 0) {
    return "PERP_DRAFT_PRICE";
  }
  if (
    !Number.isSafeInteger(draft.leverage) ||
    draft.leverage < 1 ||
    draft.leverage > HYPERLIQUID_PERP_POLICY.maxLeverage
  ) {
    return "PERP_DRAFT_LEVERAGE";
  }
  if (!Number.isFinite(draft.dailyPnl)) return "PERP_DRAFT_DAILY_PNL";
  return null;
};

const permissionsSatisfied = (permissions: PerpOrderUiPermissions): boolean =>
  permissions.canControl && permissions.canTrade;

/**
 * Machine UI du formulaire d'ordre perp : préparation, confirmation
 * explicite, soumission, issue. Aucun réseau ici — la soumission est un
 * effet du shell dashboard via le gateway ; le shell génère le
 * clientOrderId au clic de confirmation et la machine valide son format.
 * Source de vérité : models/perp-order-ui.md.
 */
export const perpOrderUiMachine = setup({
  types: {
    context: {} as PerpOrderUiContext,
    events: {} as PerpOrderUiEvent,
    input: {} as PerpOrderUiInput,
  },
  guards: {
    validDraft: ({ event }) =>
      event.type === "SUBMISSION_PREPARED" &&
      draftRefusal(event.draft) === null &&
      permissionsSatisfied(event.permissions),
    validClientOrderId: ({ event }) =>
      event.type === "PERP_ORDER_CONFIRMED" &&
      CLIENT_ORDER_ID_PATTERN.test(event.clientOrderId),
  },
  actions: {
    recordDraft: assign(({ event }) =>
      event.type === "SUBMISSION_PREPARED"
        ? {
            draft: Object.freeze(event.draft),
            clientOrderId: null,
            lastRefusal: null,
            lastError: null,
            result: null,
          }
        : {},
    ),
    recordDraftRefusal: assign(({ event }) => {
      if (event.type !== "SUBMISSION_PREPARED") return {};
      if (!permissionsSatisfied(event.permissions)) {
        return { lastRefusal: "PERP_PERMISSIONS_REQUIRED" as const };
      }
      return { lastRefusal: draftRefusal(event.draft) ?? "PERP_DRAFT_PRODUCT" };
    }),
    recordClientOrderId: assign(({ event }) =>
      event.type === "PERP_ORDER_CONFIRMED"
        ? { clientOrderId: event.clientOrderId, lastRefusal: null }
        : {},
    ),
    recordSubmissionIssue: assign(({ event }) => {
      if (event.type === "SUBMISSION_SUCCEEDED") {
        return { result: event.result, lastError: null };
      }
      if (event.type === "SUBMISSION_FAILED") {
        return { result: null, lastError: event.error };
      }
      return {};
    }),
    dismissResult: assign({ result: null }),
    resetForm: assign({
      draft: null,
      clientOrderId: null,
      result: null,
      lastRefusal: null,
      lastError: null,
    }),
  },
}).createMachine({
  id: "perpOrderUi",
  context: (): PerpOrderUiContext => ({
    draft: null,
    clientOrderId: null,
    result: null,
    lastRefusal: null,
    lastError: null,
  }),
  initial: "form",
  on: {
    PERP_ORDER_FORM_RESET: { target: ".form", actions: "resetForm" },
  },
  states: {
    form: {
      on: {
        SUBMISSION_PREPARED: [
          {
            guard: "validDraft",
            target: "confirming",
            actions: "recordDraft",
          },
          { actions: "recordDraftRefusal" },
        ],
      },
    },
    confirming: {
      on: {
        PERP_ORDER_CONFIRMED: [
          {
            guard: "validClientOrderId",
            target: "submitting",
            actions: "recordClientOrderId",
          },
        ],
        PERP_ORDER_CANCELLED: { target: "form" },
      },
    },
    submitting: {
      on: {
        SUBMISSION_SUCCEEDED: {
          target: "result",
          actions: "recordSubmissionIssue",
        },
        SUBMISSION_FAILED: {
          target: "result",
          actions: "recordSubmissionIssue",
        },
      },
    },
    result: {
      on: {
        SUBMISSION_DISMISSED: { target: "form", actions: "dismissResult" },
      },
    },
  },
});
