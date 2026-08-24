import type { PaperPortfolio } from "@dodash/backtest";
import {
  createFill,
  err,
  ok,
  type Fill,
  type OrderIntent,
  type ProductId,
  type Result,
} from "@dodash/domain";
import { LIVE_TRADING_POLICY, type WorkflowError } from "@dodash/models";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.js";
import {
  createCoinbaseJwt,
  type CoinbaseHttpMethod,
} from "./coinbase-jwt.js";
import type { ExecutionAuthorization, OrderSubmission } from "./types.js";

export const COINBASE_CREATE_ORDER_PATH = "/api/v3/brokerage/orders";
export const coinbaseProductPath = (productId: string): string =>
  `/api/v3/brokerage/products/${encodeURIComponent(productId)}`;
const MAX_COINBASE_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CoinbaseExecutionSettings {
  readonly apiBaseUrl: string;
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
  readonly portfolioId: string;
}

export interface CoinbaseJwtCredential {
  readonly kind: "coinbase-jwt";
  readonly token: string;
  readonly method: CoinbaseHttpMethod;
  readonly host: string;
  readonly path: string;
}

export interface CoinbaseProtectionPlan {
  readonly stopLossPrice: number;
  readonly takeProfitPrice: number;
}

export interface CoinbaseRequestDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

export const coinbaseOrderPath = (exchangeOrderId: string): string => {
  if (exchangeOrderId.trim().length === 0) {
    throw new Error("INVALID_COINBASE_ORDER_ID");
  }
  return `${COINBASE_CREATE_ORDER_PATH}/historical/${encodeURIComponent(exchangeOrderId)}`;
};

export type CoinbaseSettingsInput = {
  readonly LIVE_TRADING_ENABLED?: string;
  readonly COINBASE_API_BASE_URL?: string;
  readonly COINBASE_API_KEY_ID?: string;
  readonly COINBASE_API_PRIVATE_KEY?: string;
  readonly COINBASE_PORTFOLIO_ID?: string;
  readonly TRADING_TELEMETRY?: unknown;
};

const createOrderResponseSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      success_response: z.object({
        order_id: z.string().min(1),
        product_id: z.string().min(1),
        side: z.enum(["BUY", "SELL"]),
        client_order_id: z.string().min(1),
      }),
    })
    .passthrough(),
  z
    .object({
      success: z.literal(false),
      error_response: z.object({
        error: z.string().optional(),
        message: z.string().optional(),
        error_details: z.string().optional(),
      }),
    })
    .passthrough(),
]);

const orderSchema = z
  .object({
    order_id: z.string().min(1),
    product_id: z.string().min(1),
    client_order_id: z.string().min(1),
    side: z.enum(["BUY", "SELL"]),
    status: z.enum([
      "PENDING",
      "OPEN",
      "FILLED",
      "CANCELLED",
      "EXPIRED",
      "FAILED",
      "UNKNOWN_ORDER_STATUS",
      "QUEUED",
      "CANCEL_QUEUED",
      "EDIT_QUEUED",
    ]),
    average_filled_price: z.string(),
    total_fees: z.string(),
    filled_size: z.string(),
    last_fill_time: z.string().optional(),
    last_update_time: z.string().optional(),
    attached_order_id: z.string().min(1).optional(),
    order_configuration: z
      .object({
        trigger_bracket_gtc: z.object({
          base_size: z.union([z.string(), z.number()]),
          limit_price: z.string(),
          stop_trigger_price: z.string(),
        }),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const getOrderResponseSchema = z
  .object({ order: orderSchema })
  .passthrough();

const productTradingRulesSchema = z
  .object({
    product_id: z.string().min(1),
    base_increment: z.string().min(1),
    quote_increment: z.string().min(1),
    base_min_size: z.string().min(1),
    trading_disabled: z.boolean().optional().default(false),
    cancel_only: z.boolean().optional().default(false),
    view_only: z.boolean().optional().default(false),
    is_disabled: z.boolean().optional().default(false),
  })
  .passthrough();

const executionError = (
  code: WorkflowError["code"],
  retryable: boolean,
): WorkflowError => ({ phase: "execution", code, retryable });

const reconciliationError = (
  code: WorkflowError["code"] = "RECONCILIATION_FAILURE",
  retryable = true,
): WorkflowError => ({ phase: "reconciliation", code, retryable });

const authorizationError = (): WorkflowError => ({
  phase: "authorization",
  code: "AUTHENTICATION_FAILURE",
  retryable: false,
});

const requestTarget = (
  settings: CoinbaseExecutionSettings,
  path: string,
): { readonly host: string; readonly url: string } => {
  const base = new URL(settings.apiBaseUrl);
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    (base.pathname !== "/" && base.pathname !== "")
  ) {
    throw new Error("INVALID_COINBASE_API_BASE_URL");
  }
  return { host: base.host, url: new URL(path, base).toString() };
};

export const resolveCoinbaseSettings = (
  input: CoinbaseSettingsInput,
): Result<CoinbaseExecutionSettings, { readonly code: "LIVE_EXECUTION_UNAVAILABLE" }> => {
  if (input.LIVE_TRADING_ENABLED !== "true") {
    return err({ code: "LIVE_EXECUTION_UNAVAILABLE" });
  }
  return resolveCoinbasePreflightSettings(input);
};

export const resolveCoinbasePreflightSettings = (
  input: CoinbaseSettingsInput,
): Result<CoinbaseExecutionSettings, { readonly code: "LIVE_EXECUTION_UNAVAILABLE" }> => {
  const apiKeyId = input.COINBASE_API_KEY_ID?.trim() ?? "";
  const privateKeyPem = input.COINBASE_API_PRIVATE_KEY?.trim() ?? "";
  const portfolioId = input.COINBASE_PORTFOLIO_ID?.trim() ?? "";
  const apiBaseUrl = input.COINBASE_API_BASE_URL?.trim() || "https://api.coinbase.com";
  if (
    apiKeyId.length === 0 ||
    privateKeyPem.length === 0 ||
    portfolioId.length === 0
  ) {
    return err({ code: "LIVE_EXECUTION_UNAVAILABLE" });
  }
  try {
    requestTarget(
      { apiBaseUrl, apiKeyId, privateKeyPem, portfolioId },
      COINBASE_CREATE_ORDER_PATH,
    );
  } catch {
    return err({ code: "LIVE_EXECUTION_UNAVAILABLE" });
  }
  return ok(Object.freeze({ apiBaseUrl, apiKeyId, privateKeyPem, portfolioId }));
};

export const createCoinbaseAuthorization = (
  settings: CoinbaseExecutionSettings,
  method: CoinbaseHttpMethod,
  path: string,
  dependencies: CoinbaseRequestDependencies = {},
): Result<ExecutionAuthorization, WorkflowError> => {
  try {
    const target = requestTarget(settings, path);
    const now = dependencies.now?.() ?? Date.now();
    const jwt = createCoinbaseJwt({
      apiKeyId: settings.apiKeyId,
      privateKeyPem: settings.privateKeyPem,
      method,
      host: target.host,
      path,
      nowSeconds: Math.floor(now / 1_000),
      ...(dependencies.nonce === undefined
        ? {}
        : { nonce: dependencies.nonce() }),
    });
    const credential: CoinbaseJwtCredential = Object.freeze({
      kind: "coinbase-jwt",
      token: jwt.token,
      method,
      host: target.host,
      path,
    });
    return ok({
      issuedAt: jwt.issuedAt,
      expiresAt: jwt.expiresAt,
      credential,
    });
  } catch {
    return err(authorizationError());
  }
};

const isCredentialFor = (
  authorization: ExecutionAuthorization,
  method: CoinbaseHttpMethod,
  host: string,
  path: string,
  now: number,
): authorization is ExecutionAuthorization & {
  readonly credential: CoinbaseJwtCredential;
} => {
  const credential = authorization.credential;
  return (
    typeof credential === "object" &&
    credential !== null &&
    "kind" in credential &&
    credential.kind === "coinbase-jwt" &&
    "token" in credential &&
    typeof credential.token === "string" &&
    credential.token.length > 0 &&
    "method" in credential &&
    credential.method === method &&
    "host" in credential &&
    credential.host === host &&
    "path" in credential &&
    credential.path === path &&
    authorization.issuedAt <= now &&
    authorization.expiresAt > now
  );
};

const decimalString = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("INVALID_DECIMAL_VALUE");
  }
  const source = value.toString();
  if (!/[eE]/.test(source)) return source;
  const [coefficient = "", exponentSource = ""] = source.toLowerCase().split("e");
  const exponent = Number(exponentSource);
  const [integer = "", fraction = ""] = coefficient.replace("-", "").split(".");
  const digits = `${integer}${fraction}`;
  const decimalAt = integer.length + exponent;
  if (decimalAt <= 0) return `0.${"0".repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${digits}${"0".repeat(decimalAt - digits.length)}`;
  return `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
};

interface FormattedProtectionPlan {
  readonly stopTriggerPrice: string;
  readonly takeProfitPrice: string;
  readonly baseIncrement: string;
  readonly baseMinimum: string;
}

const decimalPlaces = (value: string): number | null => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  return value.split(".")[1]?.length ?? 0;
};

const roundToIncrement = (
  value: number,
  incrementSource: string,
  direction: "UP" | "DOWN",
): string | null => {
  const increment = Number(incrementSource);
  const decimals = decimalPlaces(incrementSource);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(increment) ||
    increment <= 0 ||
    decimals === null
  ) {
    return null;
  }
  const rawUnits = value / increment;
  const tolerance =
    Math.max(1, Math.abs(rawUnits)) * Number.EPSILON * 16;
  const units =
    direction === "UP"
      ? Math.ceil(rawUnits - tolerance)
      : Math.floor(rawUnits + tolerance);
  if (units <= 0) return null;
  return (units * increment).toFixed(decimals);
};

const loadFormattedProtection = async (
  settings: CoinbaseExecutionSettings,
  productId: string,
  protection: CoinbaseProtectionPlan,
  dependencies: CoinbaseRequestDependencies,
): Promise<Result<FormattedProtectionPlan, WorkflowError>> => {
  const path = coinbaseProductPath(productId);
  const authorization = createCoinbaseAuthorization(settings, "GET", path, dependencies);
  if (!authorization.ok) return authorization;
  let target: ReturnType<typeof requestTarget>;
  try {
    target = requestTarget(settings, path);
  } catch {
    return err(executionError("INVALID_RESPONSE", false));
  }
  const now = dependencies.now?.() ?? Date.now();
  if (!isCredentialFor(authorization.value, "GET", target.host, path, now)) {
    return err(executionError("AUTHORIZATION_EXPIRED", true));
  }
  const response = await safeFetch(
    target.url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.value.credential.token}`,
      },
    },
    dependencies,
  );
  if (response === null || response.status >= 500) {
    return err(executionError("NETWORK_UNAVAILABLE", true));
  }
  if (response.status === 429) return err(executionError("RATE_LIMITED", true));
  if (!response.ok) return err(executionError("INVALID_RESPONSE", false));
  try {
    const parsed = productTradingRulesSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (
      !parsed.success ||
      parsed.data.product_id !== productId ||
      parsed.data.trading_disabled ||
      parsed.data.cancel_only ||
      parsed.data.view_only ||
      parsed.data.is_disabled
    ) {
      return err(executionError("INVALID_RESPONSE", false));
    }
    const baseIncrement = Number(parsed.data.base_increment);
    const baseMinimum = Number(parsed.data.base_min_size);
    if (
      !Number.isFinite(baseIncrement) ||
      baseIncrement <= 0 ||
      !Number.isFinite(baseMinimum) ||
      baseMinimum <= 0
    ) {
      return err(executionError("INVALID_RESPONSE", false));
    }
    const stopTriggerPrice = roundToIncrement(
      protection.stopLossPrice,
      parsed.data.quote_increment,
      "UP",
    );
    const takeProfitPrice = roundToIncrement(
      protection.takeProfitPrice,
      parsed.data.quote_increment,
      "DOWN",
    );
    if (
      stopTriggerPrice === null ||
      takeProfitPrice === null ||
      Number(stopTriggerPrice) >= Number(takeProfitPrice)
    ) {
      return err(executionError("INVALID_RESPONSE", false));
    }
    return ok(
      Object.freeze({
        stopTriggerPrice,
        takeProfitPrice,
        baseIncrement: parsed.data.base_increment,
        baseMinimum: parsed.data.base_min_size,
      }),
    );
  } catch {
    return err(executionError("INVALID_RESPONSE", false));
  }
};

export const verifyCoinbaseProductTradingRules = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<void, WorkflowError>> => {
  const verified = await loadFormattedProtection(
    settings,
    productId,
    { stopLossPrice: 1, takeProfitPrice: 2 },
    dependencies,
  );
  return verified.ok ? ok(undefined) : verified;
};

const coinbaseBaseSize = (productId: string, quantity: number): string => {
  const increments = LIVE_TRADING_POLICY.baseIncrements as Readonly<
    Record<string, number>
  >;
  const increment = increments[productId];
  if (increment === undefined) return decimalString(quantity);
  const incrementString = decimalString(increment);
  const decimals = incrementString.split(".")[1]?.length ?? 0;
  const units = Math.floor(quantity / increment + 1e-9);
  if (units <= 0) throw new Error("QUANTITY_BELOW_BASE_INCREMENT");
  return (units * increment).toFixed(decimals);
};

const formatBaseSize = (
  quantity: number,
  incrementSource: string,
  minimumSource: string,
): string | null => {
  const increment = Number(incrementSource);
  const minimum = Number(minimumSource);
  const decimals = decimalPlaces(incrementSource);
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(increment) ||
    increment <= 0 ||
    !Number.isFinite(minimum) ||
    minimum <= 0 ||
    decimals === null
  ) {
    return null;
  }
  const units = Math.floor(quantity / increment + Number.EPSILON * 16);
  const rounded = units * increment;
  if (units <= 0 || rounded + Number.EPSILON < minimum) return null;
  return rounded.toFixed(decimals);
};

const safeFetch = async (
  url: string,
  init: RequestInit,
  dependencies: CoinbaseRequestDependencies,
): Promise<Response | null> => {
  try {
    return await (dependencies.fetch ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
};

export const submitCoinbaseOrder = async (
  settings: CoinbaseExecutionSettings,
  intent: OrderIntent,
  authorization: ExecutionAuthorization,
  dependencies: CoinbaseRequestDependencies = {},
  protection?: CoinbaseProtectionPlan,
): Promise<OrderSubmission> => {
  let target: ReturnType<typeof requestTarget>;
  try {
    target = requestTarget(settings, COINBASE_CREATE_ORDER_PATH);
  } catch {
    return {
      status: "REJECTED",
      error: executionError("ORDER_REJECTED", false),
    };
  }
  const now = dependencies.now?.() ?? Date.now();
  if (
    !isCredentialFor(
      authorization,
      "POST",
      target.host,
      COINBASE_CREATE_ORDER_PATH,
      now,
    )
  ) {
    return {
      status: "REJECTED",
      error: executionError("AUTHORIZATION_EXPIRED", true),
    };
  }

  let formattedProtection: FormattedProtectionPlan | undefined;
  if (intent.side === "BUY" && protection !== undefined) {
    const formatted = await loadFormattedProtection(
      settings,
      intent.productId,
      protection,
      dependencies,
    );
    if (!formatted.ok) {
      return { status: "REJECTED", error: formatted.error };
    }
    formattedProtection = formatted.value;
  }

  let body: string;
  try {
    body = JSON.stringify({
      client_order_id: intent.clientOrderId,
      product_id: intent.productId,
      side: intent.side,
      order_configuration: {
        market_market_ioc: {
          base_size: coinbaseBaseSize(intent.productId, intent.quantity),
        },
      },
      ...(formattedProtection === undefined
        ? {}
        : {
            attached_order_configuration: {
              trigger_bracket_gtc: {
                limit_price: formattedProtection.takeProfitPrice,
                stop_trigger_price: formattedProtection.stopTriggerPrice,
              },
            },
          }),
    });
  } catch {
    return {
      status: "REJECTED",
      error: executionError("ORDER_REJECTED", false),
    };
  }

  const response = await safeFetch(
    target.url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.credential.token}`,
        "content-type": "application/json",
      },
      body,
    },
    dependencies,
  );
  if (response === null || response.status >= 500) {
    return {
      status: "UNKNOWN",
      error: executionError("ORDER_OUTCOME_UNKNOWN", true),
    };
  }
  if (response.status === 429) {
    return {
      status: "REJECTED",
      error: executionError("RATE_LIMITED", true),
    };
  }
  if (!response.ok) {
    return {
      status: "REJECTED",
      error: executionError("ORDER_REJECTED", false),
    };
  }

  try {
    const parsed = createOrderResponseSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success) {
      return {
        status: "UNKNOWN",
        error: executionError("INVALID_RESPONSE", true),
      };
    }
    if (!parsed.data.success) {
      return {
        status: "REJECTED",
        error: executionError("ORDER_REJECTED", false),
      };
    }
    const acknowledgement = parsed.data.success_response;
    if (
      acknowledgement.client_order_id !== intent.clientOrderId ||
      acknowledgement.product_id !== intent.productId ||
      acknowledgement.side !== intent.side
    ) {
      return {
        status: "UNKNOWN",
        error: executionError("INVALID_RESPONSE", true),
      };
    }
    return {
      status: "UNKNOWN",
      exchangeOrderId: acknowledgement.order_id,
      error: executionError("ORDER_OUTCOME_UNKNOWN", true),
    };
  } catch {
    return {
      status: "UNKNOWN",
      error: executionError("INVALID_RESPONSE", true),
    };
  }
};

interface LiveFillApplication {
  readonly portfolio: PaperPortfolio;
  readonly fill: Fill;
}

export const applyCoinbaseFill = (
  portfolio: PaperPortfolio,
  intent: OrderIntent,
  input: {
    readonly exchangeOrderId: string;
    readonly price: number;
    readonly quantity: number;
    readonly fee: number;
    readonly executedAt: number;
  },
): Result<LiveFillApplication, { readonly code: "INVALID_FILL" }> => {
  if (input.quantity > intent.quantity * (1 + Number.EPSILON * 8)) {
    return err({ code: "INVALID_FILL" });
  }
  const fill = createFill({
    fillId: `coinbase:${input.exchangeOrderId}`,
    clientOrderId: intent.clientOrderId,
    exchangeOrderId: input.exchangeOrderId,
    price: input.price,
    quantity: input.quantity,
    fee: input.fee,
    executedAt: input.executedAt,
  });
  if (!fill.ok) return err({ code: "INVALID_FILL" });

  const direction = intent.side === "BUY" ? 1 : -1;
  const current = portfolio.positionQuantity;
  const delta = direction * fill.value.quantity;
  const sameDirection = current === 0 || Math.sign(current) === Math.sign(delta);
  const nextQuantity = current + delta;
  let averagePrice = portfolio.averagePrice;
  if (sameDirection) {
    averagePrice =
      nextQuantity === 0
        ? 0
        : (Math.abs(current) * portfolio.averagePrice +
            Math.abs(delta) * fill.value.price) /
          Math.abs(nextQuantity);
  } else if (nextQuantity === 0) {
    averagePrice = 0;
  } else if (Math.sign(nextQuantity) !== Math.sign(current)) {
    averagePrice = fill.value.price;
  }
  const gross = fill.value.price * fill.value.quantity;
  const cashDelta = intent.side === "BUY" ? -(gross + fill.value.fee) : gross - fill.value.fee;
  return ok({
    fill: fill.value,
    portfolio: Object.freeze({
      cash: portfolio.cash + cashDelta,
      positionQuantity: nextQuantity,
      averagePrice,
    }),
  });
};

const parseFinite = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const terminalStatuses = new Set(["FILLED", "CANCELLED", "EXPIRED", "FAILED"]);

export const getCoinbaseOrder = async (
  settings: CoinbaseExecutionSettings,
  intent: OrderIntent,
  exchangeOrderId: string,
  authorization: ExecutionAuthorization,
  portfolio: PaperPortfolio,
  dependencies: CoinbaseRequestDependencies = {},
  protection?: CoinbaseProtectionPlan,
): Promise<Result<OrderSubmission, WorkflowError>> => {
  let path: string;
  try {
    path = coinbaseOrderPath(exchangeOrderId);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
  let target: ReturnType<typeof requestTarget>;
  try {
    target = requestTarget(settings, path);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
  const now = dependencies.now?.() ?? Date.now();
  if (!isCredentialFor(authorization, "GET", target.host, path, now)) {
    return err(reconciliationError("AUTHORIZATION_EXPIRED", true));
  }
  const response = await safeFetch(
    target.url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.credential.token}`,
      },
    },
    dependencies,
  );
  if (response === null || response.status === 429 || response.status >= 500) {
    return err(reconciliationError());
  }
  if (!response.ok) return err(reconciliationError("INVALID_RESPONSE", false));

  try {
    const parsed = getOrderResponseSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success) return err(reconciliationError("INVALID_RESPONSE", false));
    const order = parsed.data.order;
    if (
      order.order_id !== exchangeOrderId ||
      order.client_order_id !== intent.clientOrderId ||
      order.product_id !== intent.productId ||
      order.side !== intent.side
    ) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    if (!terminalStatuses.has(order.status)) return err(reconciliationError());

    const protectiveOrderId = order.attached_order_id;
    if (
      intent.side === "BUY" &&
      protection !== undefined &&
      protectiveOrderId === undefined
    ) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }

    const quantity = parseFinite(order.filled_size);
    const price = parseFinite(order.average_filled_price);
    const fee = parseFinite(order.total_fees);
    if (quantity === null || quantity < 0 || fee === null || fee < 0) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    if (quantity === 0) {
      return ok({
        status: "REJECTED",
        error: executionError("ORDER_REJECTED", false),
      });
    }
    if (price === null || price <= 0) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }

    const rawTime = order.last_fill_time || order.last_update_time;
    const parsedTime = rawTime === undefined ? Number.NaN : Date.parse(rawTime);
    const executedAt = Number.isFinite(parsedTime) ? parsedTime : now;
    const applied = applyCoinbaseFill(portfolio, intent, {
      exchangeOrderId,
      price,
      quantity,
      fee,
      executedAt,
    });
    if (!applied.ok) return err(reconciliationError("INVALID_RESPONSE", false));
    return ok({
      status: "CONFIRMED",
      exchangeOrderId,
      portfolio: applied.value.portfolio,
      fill: applied.value.fill,
      ...(protectiveOrderId === undefined ? {} : { protectiveOrderId }),
    });
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
};

const protectiveStatuses = new Set(["PENDING", "OPEN", "QUEUED"]);

export const confirmCoinbaseProtectiveOrder = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  protectiveOrderId: string,
  protection: CoinbaseProtectionPlan,
  dependencies: CoinbaseRequestDependencies = {},
  expectedQuantity?: number,
): Promise<Result<void, WorkflowError>> => {
  const formatted = await loadFormattedProtection(
    settings,
    productId,
    protection,
    dependencies,
  );
  if (!formatted.ok) {
    return err({ ...formatted.error, phase: "reconciliation" });
  }
  let path: string;
  try {
    path = coinbaseOrderPath(protectiveOrderId);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
  const authorization = createCoinbaseAuthorization(settings, "GET", path, dependencies);
  if (!authorization.ok) return authorization;
  let target: ReturnType<typeof requestTarget>;
  try {
    target = requestTarget(settings, path);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
  const now = dependencies.now?.() ?? Date.now();
  if (!isCredentialFor(authorization.value, "GET", target.host, path, now)) {
    return err(reconciliationError("AUTHORIZATION_EXPIRED", true));
  }
  const response = await safeFetch(
    target.url,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.value.credential.token}`,
      },
    },
    dependencies,
  );
  if (response === null || response.status === 429 || response.status >= 500) {
    return err(reconciliationError());
  }
  if (!response.ok) return err(reconciliationError("INVALID_RESPONSE", false));
  try {
    const parsed = getOrderResponseSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    const order = parsed.data.order;
    const bracket = order.order_configuration?.trigger_bracket_gtc;
    const expectedBaseSize =
      expectedQuantity === undefined
        ? null
        : formatBaseSize(
            expectedQuantity,
            formatted.value.baseIncrement,
            formatted.value.baseMinimum,
          );
    if (
      order.order_id !== protectiveOrderId ||
      order.product_id !== productId ||
      order.side !== "SELL" ||
      !protectiveStatuses.has(order.status) ||
      bracket === undefined ||
      Number(bracket.base_size) <= 0 ||
      (expectedQuantity !== undefined &&
        (expectedBaseSize === null ||
          Number(bracket.base_size) !== Number(expectedBaseSize))) ||
      bracket.limit_price !== formatted.value.takeProfitPrice ||
      bracket.stop_trigger_price !== formatted.value.stopTriggerPrice
    ) {
      return err(reconciliationError("INVALID_RESPONSE", false));
    }
    return ok(undefined);
  } catch {
    return err(reconciliationError("INVALID_RESPONSE", false));
  }
};

export const submitCoinbaseProtectionOrder = async (
  settings: CoinbaseExecutionSettings,
  productId: ProductId,
  clientOrderId: string,
  quantity: number,
  protection: CoinbaseProtectionPlan,
  dependencies: CoinbaseRequestDependencies = {},
): Promise<Result<{ readonly protectiveOrderId: string }, WorkflowError>> => {
  if (clientOrderId.trim().length === 0) {
    return err(executionError("INVALID_RESPONSE", false));
  }
  const formatted = await loadFormattedProtection(
    settings,
    productId,
    protection,
    dependencies,
  );
  if (!formatted.ok) return formatted;
  const baseSize = formatBaseSize(
    quantity,
    formatted.value.baseIncrement,
    formatted.value.baseMinimum,
  );
  if (baseSize === null) {
    return err(executionError("INVALID_RESPONSE", false));
  }
  const authorization = createCoinbaseAuthorization(
    settings,
    "POST",
    COINBASE_CREATE_ORDER_PATH,
    dependencies,
  );
  if (!authorization.ok) return authorization;
  let target: ReturnType<typeof requestTarget>;
  try {
    target = requestTarget(settings, COINBASE_CREATE_ORDER_PATH);
  } catch {
    return err(executionError("INVALID_RESPONSE", false));
  }
  const now = dependencies.now?.() ?? Date.now();
  if (
    !isCredentialFor(
      authorization.value,
      "POST",
      target.host,
      COINBASE_CREATE_ORDER_PATH,
      now,
    )
  ) {
    return err(executionError("AUTHORIZATION_EXPIRED", true));
  }
  const body = JSON.stringify({
    client_order_id: clientOrderId,
    product_id: productId,
    side: "SELL",
    order_configuration: {
      trigger_bracket_gtc: {
        base_size: baseSize,
        limit_price: formatted.value.takeProfitPrice,
        stop_trigger_price: formatted.value.stopTriggerPrice,
      },
    },
  });
  const response = await safeFetch(
    target.url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authorization.value.credential.token}`,
        "content-type": "application/json",
      },
      body,
    },
    dependencies,
  );
  if (response === null || response.status >= 500) {
    return err(executionError("ORDER_OUTCOME_UNKNOWN", false));
  }
  if (response.status === 429) {
    return err(executionError("RATE_LIMITED", false));
  }
  if (!response.ok) return err(executionError("ORDER_REJECTED", false));
  try {
    const parsed = createOrderResponseSchema.safeParse(
      await readBoundedJson(response, MAX_COINBASE_RESPONSE_BYTES),
    );
    if (!parsed.success || !parsed.data.success) {
      return err(executionError("ORDER_REJECTED", false));
    }
    return ok({ protectiveOrderId: parsed.data.success_response.order_id });
  } catch {
    return err(executionError("ORDER_OUTCOME_UNKNOWN", false));
  }
};
