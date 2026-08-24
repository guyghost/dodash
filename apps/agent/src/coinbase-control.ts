import { err, ok, type OrderIntent, type ProductId, type Result } from "@dodash/domain";
import {
  LIVE_TRADING_POLICY,
  liveAccountControlMachine,
  liveSellProtectionMachine,
  type ControlPermissions,
  type LiveSellProtectionContext,
  type WorkflowError,
} from "@dodash/models";
import { createActor } from "xstate";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import {
  reconcileCoinbaseAccount,
  type CoinbaseAccountSnapshot,
} from "./coinbase-account.js";
import {
  COINBASE_CREATE_ORDER_PATH,
  coinbaseOrderPath,
  confirmCoinbaseProtectiveOrder,
  createCoinbaseAuthorization,
  getCoinbaseOrder,
  submitCoinbaseOrder,
  submitCoinbaseProtectionOrder,
  type CoinbaseExecutionSettings,
  type CoinbaseJwtCredential,
  type CoinbaseRequestDependencies,
} from "./coinbase-execution.js";
import type { OrderSubmission } from "./types.js";

export const COINBASE_LIST_ORDERS_PATH =
  "/api/v3/brokerage/orders/historical/batch";
export const COINBASE_CANCEL_ORDERS_PATH =
  "/api/v3/brokerage/orders/batch_cancel";

const MAX_COINBASE_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ORDER_PAGES = 20;
const CANCEL_BATCH_SIZE = 100;
const MAX_CONTROL_STEPS = 64;

const hash32 = (value: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const deriveCoinbaseControlClientOrderId = (source: string): string => {
  const digest = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hash32(source, seed).toString(16).padStart(8, "0"))
    .join("");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-6${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const openOrderSchema = z.object({
  order_id: z.string().min(1),
  product_id: z.string().min(1),
  status: z.enum([
    "PENDING",
    "OPEN",
    "QUEUED",
    "CANCEL_QUEUED",
    "EDIT_QUEUED",
  ]),
});

const listOrdersSchema = z
  .object({
    orders: z.array(openOrderSchema),
    has_next: z.boolean(),
    cursor: z.string(),
  })
  .passthrough();

const cancelOrdersSchema = z
  .object({
    results: z.array(
      z.object({
        success: z.boolean(),
        failure_reason: z.string(),
        order_id: z.string().min(1),
      }),
    ),
  })
  .passthrough();

const phaseError = (
  phase: "cancellation" | "reconciliation" | "execution",
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase, code, retryable });

const credentialToken = (credential: unknown): string | null => {
  if (
    typeof credential !== "object" ||
    credential === null ||
    !("kind" in credential) ||
    credential.kind !== "coinbase-jwt" ||
    !("token" in credential) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  ) {
    return null;
  }
  return (credential as CoinbaseJwtCredential).token;
};

const authorizedFetch = async (
  settings: CoinbaseExecutionSettings,
  method: "GET" | "POST",
  signedPath: string,
  requestPath: string,
  dependencies: CoinbaseRequestDependencies,
  body?: string,
): Promise<Result<Response, WorkflowError>> => {
  const now = dependencies.now?.() ?? Date.now();
  const authorization = createCoinbaseAuthorization(settings, method, signedPath, {
    now: () => now,
    ...(dependencies.nonce === undefined
      ? {}
      : { nonce: dependencies.nonce }),
  });
  if (!authorization.ok) return authorization;
  const token = credentialToken(authorization.value.credential);
  if (token === null) {
    return err(phaseError("reconciliation", "AUTHENTICATION_FAILURE", false));
  }
  try {
    const response = await (dependencies.fetch ?? fetch)(
      new URL(requestPath, settings.apiBaseUrl).toString(),
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    return ok(response);
  } catch {
    return err(phaseError("reconciliation", "NETWORK_UNAVAILABLE", true));
  }
};

const listOpenProductOrders = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  dependencies: CoinbaseRequestDependencies,
): Promise<Result<readonly string[], WorkflowError>> => {
  const orderIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const query = new URLSearchParams();
    query.append("product_ids", productId);
    for (const status of [
      "PENDING",
      "OPEN",
      "QUEUED",
      "CANCEL_QUEUED",
      "EDIT_QUEUED",
    ]) {
      query.append("order_status", status);
    }
    query.set("limit", "250");
    if (cursor !== null) query.set("cursor", cursor);
    const response = await authorizedFetch(
      settings,
      "GET",
      COINBASE_LIST_ORDERS_PATH,
      `${COINBASE_LIST_ORDERS_PATH}?${query.toString()}`,
      dependencies,
    );
    if (!response.ok) return response;
    if (response.value.status === 429 || response.value.status >= 500) {
      return err(phaseError("reconciliation", "RECONCILIATION_FAILURE", true));
    }
    if (!response.value.ok) {
      return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
    }
    try {
      const parsed = listOrdersSchema.safeParse(
        await readBoundedJson(response.value, MAX_COINBASE_RESPONSE_BYTES),
      );
      if (!parsed.success) {
        return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
      }
      if (parsed.data.orders.some((order) => order.product_id !== productId)) {
        return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
      }
      orderIds.push(...parsed.data.orders.map((order) => order.order_id));
      if (!parsed.data.has_next) return ok(Object.freeze([...new Set(orderIds)]));
      const nextCursor = parsed.data.cursor;
      if (nextCursor.length === 0 || seenCursors.has(nextCursor)) {
        return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } catch {
      return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
    }
  }
  return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
};

export const listCoinbaseOpenProductOrderIds = listOpenProductOrders;

export const reconcileCoinbaseOwnedAccount = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  knownProtectiveOrderIds: readonly string[],
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<CoinbaseAccountSnapshot, WorkflowError>> => {
  const account = await reconcileCoinbaseAccount(settings, productId, dependencies);
  if (!account.ok) return account;
  const openOrders = await listOpenProductOrders(settings, productId, dependencies);
  if (!openOrders.ok) return openOrders;
  const known = new Set(
    knownProtectiveOrderIds.filter((orderId) => orderId.trim().length > 0),
  );
  return openOrders.value.every((orderId) => known.has(orderId))
    ? account
    : err(phaseError("reconciliation", "RECONCILIATION_FAILURE", false));
};

const cancelOrderIds = async (
  settings: CoinbaseExecutionSettings,
  orderIds: readonly string[],
  dependencies: CoinbaseRequestDependencies,
): Promise<Result<void, WorkflowError>> => {
  for (let start = 0; start < orderIds.length; start += CANCEL_BATCH_SIZE) {
    const batch = orderIds.slice(start, start + CANCEL_BATCH_SIZE);
    const response = await authorizedFetch(
      settings,
      "POST",
      COINBASE_CANCEL_ORDERS_PATH,
      COINBASE_CANCEL_ORDERS_PATH,
      dependencies,
      JSON.stringify({ order_ids: batch }),
    );
    if (!response.ok) {
      return err({ ...response.error, phase: "cancellation" });
    }
    if (response.value.status === 429 || response.value.status >= 500) {
      return err(phaseError("cancellation", "CANCELLATION_FAILURE", true));
    }
    if (!response.value.ok) {
      return err(phaseError("cancellation", "CANCELLATION_FAILURE", false));
    }
    try {
      const parsed = cancelOrdersSchema.safeParse(
        await readBoundedJson(response.value, MAX_COINBASE_RESPONSE_BYTES),
      );
      const expected = new Set(batch);
      if (
        !parsed.success ||
        parsed.data.results.length !== expected.size ||
        parsed.data.results.some(
          (result) => !result.success || !expected.delete(result.order_id),
        ) ||
        expected.size !== 0
      ) {
        return err(phaseError("cancellation", "CANCELLATION_FAILURE", false));
      }
    } catch {
      return err(phaseError("cancellation", "CANCELLATION_FAILURE", false));
    }
  }
  return ok(undefined);
};

const cancelAndConfirmProductOrders = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  dependencies: CoinbaseRequestDependencies,
): Promise<Result<void, WorkflowError>> => {
  const listed = await listOpenProductOrders(settings, productId, dependencies);
  if (!listed.ok) {
    return err({ ...listed.error, phase: "cancellation" });
  }
  if (listed.value.length === 0) return ok(undefined);
  const cancelled = await cancelOrderIds(settings, listed.value, dependencies);
  if (!cancelled.ok) return cancelled;
  const confirmed = await listOpenProductOrders(settings, productId, dependencies);
  if (!confirmed.ok) return err({ ...confirmed.error, phase: "cancellation" });
  return confirmed.value.length === 0
    ? ok(undefined)
    : err(phaseError("cancellation", "CANCELLATION_FAILURE", true));
};

export const clearCoinbaseOwnedProtections = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  knownProtectiveOrderIds: readonly string[],
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<void, WorkflowError>> => {
  const known = new Set(
    knownProtectiveOrderIds.filter((orderId) => orderId.trim().length > 0),
  );
  const listed = await listOpenProductOrders(settings, productId, dependencies);
  if (!listed.ok) return err({ ...listed.error, phase: "cancellation" });
  if (listed.value.some((orderId) => !known.has(orderId))) {
    return err(phaseError("cancellation", "CANCELLATION_FAILURE", false));
  }
  if (listed.value.length === 0) return ok(undefined);
  const cancelled = await cancelOrderIds(settings, listed.value, dependencies);
  if (!cancelled.ok) return cancelled;
  const confirmed = await listOpenProductOrders(settings, productId, dependencies);
  if (!confirmed.ok) return err({ ...confirmed.error, phase: "cancellation" });
  return confirmed.value.length === 0
    ? ok(undefined)
    : err(phaseError("cancellation", "CANCELLATION_FAILURE", true));
};

const accountAndOrderCount = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  dependencies: CoinbaseRequestDependencies,
): Promise<
  Result<
    { readonly account: CoinbaseAccountSnapshot; readonly openOrderCount: number },
    WorkflowError
  >
> => {
  const account = await reconcileCoinbaseAccount(settings, productId, dependencies);
  if (!account.ok) return account;
  const orders = await listOpenProductOrders(settings, productId, dependencies);
  if (!orders.ok) return orders;
  return ok({ account: account.value, openOrderCount: orders.value.length });
};

const flattenReconciledPosition = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  clientOrderId: string,
  quantity: number,
  portfolio: CoinbaseAccountSnapshot["portfolio"],
  dependencies: CoinbaseRequestDependencies,
): Promise<"CONFIRMED" | "UNKNOWN" | { readonly error: WorkflowError }> => {
  const intent: OrderIntent = Object.freeze({
    clientOrderId,
    decisionId: clientOrderId,
    strategyIds: Object.freeze(["kill-switch"]),
    productId,
    side: "SELL",
    type: "MARKET",
    quantity,
    limitPrice: null,
  });
  const authorization = createCoinbaseAuthorization(
    settings,
    "POST",
    COINBASE_CREATE_ORDER_PATH,
    dependencies,
  );
  if (!authorization.ok) return { error: authorization.error };
  const submitted = await submitCoinbaseOrder(
    settings,
    intent,
    authorization.value,
    dependencies,
  );
  if (submitted.status === "REJECTED") return { error: submitted.error };
  if (submitted.status === "CONFIRMED") return "CONFIRMED";
  if (submitted.status !== "UNKNOWN") {
    return {
      error:
        "error" in submitted
          ? submitted.error
          : phaseError("execution", "INVALID_RESPONSE", false),
    };
  }
  const exchangeOrderId = submitted.exchangeOrderId ?? null;
  if (exchangeOrderId === null) return "UNKNOWN";
  const path = coinbaseOrderPath(exchangeOrderId);
  const lookupAuthorization = createCoinbaseAuthorization(
    settings,
    "GET",
    path,
    dependencies,
  );
  if (!lookupAuthorization.ok) return "UNKNOWN";
  const reconciled = await getCoinbaseOrder(
    settings,
    intent,
    exchangeOrderId,
    lookupAuthorization.value,
    portfolio,
    dependencies,
  );
  if (!reconciled.ok) return "UNKNOWN";
  return reconciled.value.status === "CONFIRMED"
    ? "CONFIRMED"
    : reconciled.value.status === "REJECTED"
      ? { error: reconciled.value.error }
      : reconciled.value.status === "UNKNOWN"
        ? "UNKNOWN"
        : {
            error:
              "error" in reconciled.value
                ? reconciled.value.error
                : phaseError("reconciliation", "INVALID_RESPONSE", false),
          };
};

export const executeCoinbaseKill = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  permissions: ControlPermissions,
  flattenClientOrderPrefix: string,
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<CoinbaseAccountSnapshot, WorkflowError>> => {
  const increment = (LIVE_TRADING_POLICY.baseIncrements as Readonly<Record<string, number>>)[
    productId
  ];
  if (increment === undefined) {
    return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
  }
  const actor = createActor(liveAccountControlMachine, { input: {} }).start();
  actor.send({
    type: "KILL_REQUESTED",
    productId,
    flattenClientOrderPrefix,
    permissions,
  });
  let lastAccount: CoinbaseAccountSnapshot | null = null;
  const wait =
    dependencies.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const retryDelayMs = (attempt: number): number =>
    Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));

  for (let step = 0; step < MAX_CONTROL_STEPS; step += 1) {
    const snapshot = actor.getSnapshot();
    switch (snapshot.value) {
      case "cancellingOrders": {
        const result = await cancelAndConfirmProductOrders(
          settings,
          productId,
          dependencies,
        );
        actor.send(
          result.ok
            ? { type: "ORDERS_CLEARED" }
            : { type: "OPERATION_FAILED", error: result.error },
        );
        break;
      }
      case "reconcilingPosition":
      case "verifyingFlat": {
        const result = await accountAndOrderCount(
          settings,
          productId,
          dependencies,
        );
        if (!result.ok) {
          actor.send({ type: "OPERATION_FAILED", error: result.error });
          break;
        }
        lastAccount = result.value.account;
        actor.send({
          type: "ACCOUNT_RECONCILED",
          snapshotId: result.value.account.snapshotId,
          totalBaseQuantity: result.value.account.totalBaseQuantity,
          availableBaseQuantity: result.value.account.availableBaseQuantity,
          dustQuantity: increment,
          openOrderCount: result.value.openOrderCount,
        });
        break;
      }
      case "flatteningPosition": {
        if (
          lastAccount === null ||
          snapshot.context.flattenQuantity === null ||
          snapshot.context.flattenClientOrderPrefix === null
        ) {
          actor.send({
            type: "FLATTEN_REJECTED",
            error: phaseError("execution", "INVALID_RESPONSE", false),
          });
          break;
        }
        const clientOrderId = deriveCoinbaseControlClientOrderId(
          `${snapshot.context.flattenClientOrderPrefix}\u001f${snapshot.context.snapshotId ?? "missing"}\u001f${snapshot.context.attempts.flatten}`,
        );
        const result = await flattenReconciledPosition(
          settings,
          productId,
          clientOrderId,
          snapshot.context.flattenQuantity,
          lastAccount.portfolio,
          dependencies,
        );
        actor.send(
          result === "CONFIRMED"
            ? { type: "FLATTEN_CONFIRMED" }
            : result === "UNKNOWN"
              ? { type: "FLATTEN_OUTCOME_UNKNOWN" }
              : { type: "FLATTEN_REJECTED", error: result.error },
        );
        break;
      }
      case "retryingCancellation":
        await wait(retryDelayMs(snapshot.context.attempts.cancellation));
        actor.send({ type: "RETRY_TIMER_ELAPSED" });
        break;
      case "retryingReconciliation":
        await wait(retryDelayMs(snapshot.context.attempts.reconciliation));
        actor.send({ type: "RETRY_TIMER_ELAPSED" });
        break;
      case "retryingVerification":
        await wait(retryDelayMs(snapshot.context.attempts.verification));
        actor.send({ type: "RETRY_TIMER_ELAPSED" });
        break;
      case "completed":
        actor.stop();
        return lastAccount === null
          ? err(phaseError("reconciliation", "INVALID_RESPONSE", false))
          : ok(lastAccount);
      case "failed": {
        const error =
          snapshot.context.lastError ??
          phaseError("reconciliation", "RECONCILIATION_FAILURE", false);
        actor.stop();
        return err(error);
      }
      case "idle":
        actor.stop();
        return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
      default:
        actor.stop();
        return err(phaseError("reconciliation", "INVALID_RESPONSE", false));
    }
  }
  actor.stop();
  return err(phaseError("reconciliation", "RECONCILIATION_FAILURE", false));
};

export interface CoinbaseProtectedSellPolicy {
  readonly stopLossBps: number;
  readonly takeProfitBps: number;
}

type ConfirmedOrderSubmission = Extract<
  OrderSubmission,
  { readonly status: "CONFIRMED" }
>;

export interface CoinbaseProtectedSellCheckpoint {
  readonly version: 1;
  readonly machine: {
    readonly value: string;
    readonly context: LiveSellProtectionContext;
  };
  readonly account: CoinbaseAccountSnapshot | null;
  readonly sellSubmission: ConfirmedOrderSubmission | null;
  readonly protectionPlan: {
    readonly stopLossPrice: number;
    readonly takeProfitPrice: number;
  } | null;
}

export interface CoinbaseProtectedSellPersistence {
  readonly restored: CoinbaseProtectedSellCheckpoint | null;
  persist(
    checkpoint: CoinbaseProtectedSellCheckpoint,
  ): Promise<Result<void, WorkflowError>>;
}

const residualProtectionClientOrderId = (parentClientOrderId: string): string =>
  deriveCoinbaseControlClientOrderId(`${parentClientOrderId}\u001fresidual`);

export const executeCoinbaseProtectedSell = async (
  settings: CoinbaseExecutionSettings,
  intent: OrderIntent,
  permissions: ControlPermissions,
  knownProtectiveOrderIds: readonly string[],
  policy: CoinbaseProtectedSellPolicy,
  dependencies: CoinbaseRequestDependencies = {},
  persistence?: CoinbaseProtectedSellPersistence,
): Promise<OrderSubmission> => {
  if (
    intent.side !== "SELL" ||
    !Number.isFinite(policy.stopLossBps) ||
    policy.stopLossBps <= 0 ||
    policy.stopLossBps >= 10_000 ||
    !Number.isFinite(policy.takeProfitBps) ||
    policy.takeProfitBps <= 0
  ) {
    return {
      status: "TERMINAL_FAILED",
      exchangeOrderId: null,
      fill: null,
      error: phaseError("execution", "INVALID_RESPONSE", false),
    };
  }
  const increment = (
    LIVE_TRADING_POLICY.baseIncrements as Readonly<Record<string, number>>
  )[intent.productId];
  if (increment === undefined) {
    return {
      status: "TERMINAL_FAILED",
      exchangeOrderId: null,
      fill: null,
      error: phaseError("execution", "INVALID_RESPONSE", false),
    };
  }
  const restored = persistence?.restored ?? null;
  let restoredState:
    | ReturnType<typeof liveSellProtectionMachine.resolveState>
    | undefined;
  try {
    if (
      restored !== null &&
      (restored.version !== 1 ||
        restored.machine.context.productId !== intent.productId ||
        restored.machine.context.clientOrderId !== intent.clientOrderId ||
        restored.machine.context.requestedQuantity !== intent.quantity)
    ) {
      throw new Error("INVALID_PROTECTED_SELL_CHECKPOINT");
    }
    restoredState =
      restored === null
        ? undefined
        : liveSellProtectionMachine.resolveState({
            value: restored.machine.value,
            context: structuredClone(restored.machine.context),
          });
  } catch {
    return {
      status: "TERMINAL_FAILED",
      exchangeOrderId: null,
      fill: null,
      error: phaseError("reconciliation", "INVALID_RESPONSE", false),
    };
  }
  const actor = createActor(liveSellProtectionMachine, {
    input: {},
    ...(restoredState === undefined ? {} : { snapshot: restoredState }),
  }).start();
  if (restored === null) {
    actor.send({
      type: "SELL_REQUESTED",
      productId: intent.productId,
      clientOrderId: intent.clientOrderId,
      quantity: intent.quantity,
      permissions,
    });
  }
  let account: CoinbaseAccountSnapshot | null = restored?.account ?? null;
  let sellSubmission: ConfirmedOrderSubmission | null =
    restored?.sellSubmission ?? null;
  let protectionPlan: {
    readonly stopLossPrice: number;
    readonly takeProfitPrice: number;
  } | null = restored?.protectionPlan ?? null;

  const sendAccount = (value: CoinbaseAccountSnapshot): void => {
    account = value;
    actor.send({
      type: "ACCOUNT_RECONCILED",
      snapshotId: value.snapshotId,
      totalBaseQuantity: value.totalBaseQuantity,
      availableBaseQuantity: value.availableBaseQuantity,
      averageEntryPrice: value.portfolio.averagePrice,
      dustQuantity: increment,
    });
  };

  for (let step = 0; step < MAX_CONTROL_STEPS; step += 1) {
    const snapshot = actor.getSnapshot();
    if (persistence !== undefined) {
      if (typeof snapshot.value !== "string") {
        actor.stop();
        return {
          status: "TERMINAL_FAILED",
          exchangeOrderId: snapshot.context.exchangeOrderId,
          fill: sellSubmission?.fill ?? null,
          error: {
            phase: "persistence",
            code: "PERSISTENCE_FAILURE",
            retryable: false,
          },
        };
      }
      const persisted = await persistence.persist(
        Object.freeze({
          version: 1 as const,
          machine: Object.freeze({
            value: snapshot.value,
            context: structuredClone(snapshot.context),
          }),
          account: account === null ? null : structuredClone(account),
          sellSubmission:
            sellSubmission === null ? null : structuredClone(sellSubmission),
          protectionPlan:
            protectionPlan === null ? null : structuredClone(protectionPlan),
        }),
      );
      if (!persisted.ok) {
        actor.stop();
        return {
          status: "UNKNOWN",
          ...(snapshot.context.exchangeOrderId === null
            ? {}
            : { exchangeOrderId: snapshot.context.exchangeOrderId }),
          error: { ...persisted.error, retryable: true },
        };
      }
    }
    switch (snapshot.value) {
      case "cancellingProtections": {
        const cleared = await clearCoinbaseOwnedProtections(
          settings,
          intent.productId,
          knownProtectiveOrderIds,
          dependencies,
        );
        actor.send(
          cleared.ok
            ? { type: "PROTECTIONS_CLEARED" }
            : { type: "OPERATION_FAILED", error: cleared.error },
        );
        break;
      }
      case "reconcilingBeforeSell":
      case "reconcilingResidual": {
        const reconciled = await reconcileCoinbaseAccount(
          settings,
          intent.productId,
          dependencies,
        );
        if (!reconciled.ok) {
          actor.send({ type: "OPERATION_FAILED", error: reconciled.error });
        } else {
          sendAccount(reconciled.value);
        }
        break;
      }
      case "submittingSell": {
        const authorization = createCoinbaseAuthorization(
          settings,
          "POST",
          COINBASE_CREATE_ORDER_PATH,
          dependencies,
        );
        if (!authorization.ok) {
          actor.send({ type: "OPERATION_FAILED", error: authorization.error });
          break;
        }
        const submitted = await submitCoinbaseOrder(
          settings,
          intent,
          authorization.value,
          dependencies,
        );
        if (submitted.status === "CONFIRMED") {
          sellSubmission = submitted;
          actor.send({
            type: "SELL_CONFIRMED",
            exchangeOrderId: submitted.exchangeOrderId,
          });
        } else if (submitted.status === "UNKNOWN") {
          actor.send({
            type: "SELL_OUTCOME_UNKNOWN",
            exchangeOrderId: submitted.exchangeOrderId ?? null,
          });
        } else if (submitted.status === "REJECTED") {
          actor.send({ type: "SELL_REJECTED", error: submitted.error });
        } else {
          actor.send({
            type: "OPERATION_FAILED",
            error:
              "error" in submitted
                ? submitted.error
                : phaseError("execution", "INVALID_RESPONSE", false),
          });
        }
        break;
      }
      case "reconcilingSell": {
        if (account === null) {
          actor.send({
            type: "OPERATION_FAILED",
            error: phaseError("reconciliation", "INVALID_RESPONSE", false),
          });
          break;
        }
        let exchangeOrderId = snapshot.context.exchangeOrderId;
        if (exchangeOrderId === null) {
          const authorization = createCoinbaseAuthorization(
            settings,
            "POST",
            COINBASE_CREATE_ORDER_PATH,
            dependencies,
          );
          if (!authorization.ok) {
            actor.send({ type: "OPERATION_FAILED", error: authorization.error });
            break;
          }
          const replayed = await submitCoinbaseOrder(
            settings,
            intent,
            authorization.value,
            dependencies,
          );
          if (replayed.status === "CONFIRMED") {
            sellSubmission = replayed;
            actor.send({
              type: "SELL_CONFIRMED",
              exchangeOrderId: replayed.exchangeOrderId,
            });
            break;
          }
          if (replayed.status === "REJECTED") {
            actor.send({ type: "SELL_REJECTED", error: replayed.error });
            break;
          }
          exchangeOrderId =
            replayed.status === "UNKNOWN"
              ? replayed.exchangeOrderId ?? null
              : null;
          if (exchangeOrderId === null) {
            actor.send({
              type: "OPERATION_FAILED",
              error: phaseError(
                "reconciliation",
                "ORDER_OUTCOME_UNKNOWN",
                false,
              ),
            });
            break;
          }
        }
        const path = coinbaseOrderPath(exchangeOrderId);
        const authorization = createCoinbaseAuthorization(
          settings,
          "GET",
          path,
          dependencies,
        );
        if (!authorization.ok) {
          actor.send({ type: "OPERATION_FAILED", error: authorization.error });
          break;
        }
        const reconciled = await getCoinbaseOrder(
          settings,
          intent,
          exchangeOrderId,
          authorization.value,
          account.portfolio,
          dependencies,
        );
        if (!reconciled.ok) {
          actor.send({ type: "OPERATION_FAILED", error: reconciled.error });
        } else if (reconciled.value.status === "CONFIRMED") {
          sellSubmission = reconciled.value;
          actor.send({ type: "SELL_CONFIRMED", exchangeOrderId });
        } else if (reconciled.value.status === "REJECTED") {
          actor.send({
            type: "SELL_REJECTED",
            error: reconciled.value.error,
          });
        } else {
          actor.send({
            type: "OPERATION_FAILED",
            error:
              "error" in reconciled.value
                ? reconciled.value.error
                : phaseError("reconciliation", "INVALID_RESPONSE", false),
          });
        }
        break;
      }
      case "armingResidual": {
        const quantity = snapshot.context.totalBaseQuantity;
        const averageEntryPrice = snapshot.context.averageEntryPrice;
        if (
          quantity === null ||
          averageEntryPrice === null ||
          averageEntryPrice <= 0
        ) {
          actor.send({
            type: "OPERATION_FAILED",
            error: phaseError("reconciliation", "INVALID_RESPONSE", false),
          });
          break;
        }
        protectionPlan = {
          stopLossPrice:
            averageEntryPrice * (1 - policy.stopLossBps / 10_000),
          takeProfitPrice:
            averageEntryPrice * (1 + policy.takeProfitBps / 10_000),
        };
        const submitted = await submitCoinbaseProtectionOrder(
          settings,
          intent.productId,
          residualProtectionClientOrderId(intent.clientOrderId),
          quantity,
          protectionPlan,
          dependencies,
        );
        actor.send(
          submitted.ok
            ? {
                type: "PROTECTION_ACKNOWLEDGED",
                protectiveOrderId: submitted.value.protectiveOrderId,
              }
            : { type: "OPERATION_FAILED", error: submitted.error },
        );
        break;
      }
      case "confirmingResidualProtection": {
        const protectiveOrderId = snapshot.context.protectiveOrderId;
        const quantity = snapshot.context.totalBaseQuantity;
        if (
          protectiveOrderId === null ||
          quantity === null ||
          protectionPlan === null
        ) {
          actor.send({
            type: "OPERATION_FAILED",
            error: phaseError("reconciliation", "INVALID_RESPONSE", false),
          });
          break;
        }
        const confirmed = await confirmCoinbaseProtectiveOrder(
          settings,
          intent.productId,
          protectiveOrderId,
          protectionPlan,
          dependencies,
          quantity,
        );
        actor.send(
          confirmed.ok
            ? { type: "PROTECTION_CONFIRMED" }
            : { type: "OPERATION_FAILED", error: confirmed.error },
        );
        break;
      }
      case "safetyFlattening": {
        const killed = await executeCoinbaseKill(
          settings,
          intent.productId,
          permissions,
          `sell-safety-${intent.clientOrderId}`,
          dependencies,
        );
        if (killed.ok) {
          account = killed.value;
          actor.send({ type: "SAFETY_FLATTEN_SUCCEEDED" });
        } else {
          actor.send({ type: "SAFETY_FLATTEN_FAILED", error: killed.error });
        }
        break;
      }
      case "completed": {
        const outcome = snapshot.context.outcome;
        actor.stop();
        if (outcome === "NO_SELL_NEEDED") {
          if (account === null) {
            return {
              status: "TERMINAL_FAILED",
              exchangeOrderId: null,
              fill: null,
              error: phaseError("reconciliation", "INVALID_RESPONSE", false),
            };
          }
          return {
            status: "NO_SELL_NEEDED",
            portfolio: account.portfolio,
            accountEquity: account.accountEquity,
            otherExposureNotional: account.otherExposureNotional,
            observedAt: account.observedAt,
          };
        }
        if (account === null || sellSubmission === null) {
          return {
            status: "TERMINAL_FAILED",
            exchangeOrderId: snapshot.context.exchangeOrderId,
            fill: sellSubmission?.fill ?? null,
            error: phaseError("reconciliation", "INVALID_RESPONSE", false),
          };
        }
        return {
          ...sellSubmission,
          portfolio: account.portfolio,
          accountEquity: account.accountEquity,
          otherExposureNotional: account.otherExposureNotional,
          observedAt: account.observedAt,
          ...(snapshot.context.protectiveOrderId === null
            ? {}
            : { protectiveOrderId: snapshot.context.protectiveOrderId }),
        };
      }
      case "safetyCompleted": {
        const error =
          snapshot.context.lastError ??
          phaseError("reconciliation", "RECONCILIATION_FAILURE", false);
        actor.stop();
        if (account === null) {
          return {
            status: "TERMINAL_FAILED",
            exchangeOrderId: snapshot.context.exchangeOrderId,
            fill: sellSubmission?.fill ?? null,
            error,
          };
        }
        return {
          status: "PROTECTION_FAILED",
          exchangeOrderId: snapshot.context.exchangeOrderId,
          portfolio: account.portfolio,
          fill: sellSubmission?.fill ?? null,
          accountEquity: account.accountEquity,
          otherExposureNotional: account.otherExposureNotional,
          observedAt: account.observedAt,
          error: { ...error, retryable: false },
        };
      }
      case "failed": {
        const error =
          snapshot.context.lastError ??
          phaseError("reconciliation", "RECONCILIATION_FAILURE", false);
        actor.stop();
        return {
          status: "TERMINAL_FAILED",
          exchangeOrderId: snapshot.context.exchangeOrderId,
          fill: sellSubmission?.fill ?? null,
          error: { ...error, retryable: false },
        };
      }
      case "idle":
      default:
        actor.stop();
        return {
          status: "TERMINAL_FAILED",
          exchangeOrderId: snapshot.context.exchangeOrderId,
          fill: sellSubmission?.fill ?? null,
          error: phaseError("reconciliation", "INVALID_RESPONSE", false),
        };
    }
  }
  actor.stop();
  return {
    status: "TERMINAL_FAILED",
    exchangeOrderId: null,
    fill: sellSubmission?.fill ?? null,
    error: phaseError("reconciliation", "RECONCILIATION_FAILURE", false),
  };
};
