import type { ProductId } from "./market.js";
import { err, ok, type Result } from "./result.js";

export type SignalSide = "BUY" | "SELL" | "HOLD";
export type OrderSide = Exclude<SignalSide, "HOLD">;
export type OrderType = "MARKET" | "LIMIT";

export interface Signal {
  readonly strategyId: string;
  readonly productId: ProductId;
  readonly side: SignalSide;
  readonly confidence: number;
  readonly suggestedSize: number;
  readonly reasonCode: string;
}

export interface Position {
  readonly productId: ProductId;
  readonly quantity: number;
  readonly averagePrice: number;
  readonly unrealizedPnl: number;
}

export interface OrderIntent {
  readonly clientOrderId: string;
  readonly decisionId: string;
  readonly strategyIds: readonly string[];
  readonly productId: ProductId;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly quantity: number;
  readonly limitPrice: number | null;
}

export interface Fill {
  readonly fillId: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string;
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
  readonly executedAt: number;
}

export type TradingValidationError =
  | { readonly code: "EMPTY_IDENTIFIER"; readonly field: string }
  | { readonly code: "INVALID_CONFIDENCE" }
  | { readonly code: "INVALID_SUGGESTED_SIZE" }
  | { readonly code: "HOLD_WITH_SIZE" }
  | { readonly code: "INVALID_QUANTITY" }
  | { readonly code: "INVALID_LIMIT_PRICE" }
  | { readonly code: "MARKET_WITH_LIMIT_PRICE" }
  | { readonly code: "EMPTY_STRATEGIES" }
  | { readonly code: "INVALID_POSITION" }
  | { readonly code: "INVALID_FILL" }
  | { readonly code: "INVALID_ORDER_INDEX" };

const isNonEmpty = (value: string): boolean => value.trim().length > 0;
const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

export const createSignal = (
  input: Signal,
): Result<Signal, TradingValidationError> => {
  if (!isNonEmpty(input.strategyId)) {
    return err({ code: "EMPTY_IDENTIFIER", field: "strategyId" });
  }
  if (!isNonEmpty(input.reasonCode)) {
    return err({ code: "EMPTY_IDENTIFIER", field: "reasonCode" });
  }
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    return err({ code: "INVALID_CONFIDENCE" });
  }
  if (!Number.isFinite(input.suggestedSize) || input.suggestedSize < 0) {
    return err({ code: "INVALID_SUGGESTED_SIZE" });
  }
  if (input.side === "HOLD" && input.suggestedSize !== 0) {
    return err({ code: "HOLD_WITH_SIZE" });
  }
  return ok(Object.freeze({ ...input }));
};

export const createPosition = (
  input: Position,
): Result<Position, TradingValidationError> => {
  if (
    !Number.isFinite(input.quantity) ||
    !isPositiveFinite(input.averagePrice) ||
    !Number.isFinite(input.unrealizedPnl)
  ) {
    return err({ code: "INVALID_POSITION" });
  }
  return ok(Object.freeze({ ...input }));
};

const hash32 = (value: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hex = (value: number): string => value.toString(16).padStart(8, "0");

export const createClientOrderId = (
  agentId: string,
  cycleId: string,
  decisionId: string,
  index: number,
): Result<string, TradingValidationError> => {
  for (const [field, value] of [
    ["agentId", agentId],
    ["cycleId", cycleId],
    ["decisionId", decisionId],
  ] as const) {
    if (!isNonEmpty(value)) return err({ code: "EMPTY_IDENTIFIER", field });
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    return err({ code: "INVALID_ORDER_INDEX" });
  }

  const source = `${agentId}\u001f${cycleId}\u001f${decisionId}\u001f${index}`;
  const digest = [
    hash32(source, 0x811c9dc5),
    hash32(source, 0x9e3779b9),
    hash32(source, 0x85ebca6b),
    hash32(source, 0xc2b2ae35),
  ]
    .map(hex)
    .join("");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return ok(uuid);
};

export const createOrderIntent = (
  input: OrderIntent,
): Result<OrderIntent, TradingValidationError> => {
  for (const [field, value] of [
    ["clientOrderId", input.clientOrderId],
    ["decisionId", input.decisionId],
  ] as const) {
    if (!isNonEmpty(value)) return err({ code: "EMPTY_IDENTIFIER", field });
  }
  if (input.strategyIds.length === 0 || input.strategyIds.some((id) => !isNonEmpty(id))) {
    return err({ code: "EMPTY_STRATEGIES" });
  }
  if (!isPositiveFinite(input.quantity)) {
    return err({ code: "INVALID_QUANTITY" });
  }
  if (input.type === "LIMIT" && (input.limitPrice === null || !isPositiveFinite(input.limitPrice))) {
    return err({ code: "INVALID_LIMIT_PRICE" });
  }
  if (input.type === "MARKET" && input.limitPrice !== null) {
    return err({ code: "MARKET_WITH_LIMIT_PRICE" });
  }
  return ok(
    Object.freeze({
      ...input,
      strategyIds: Object.freeze([...input.strategyIds]),
    }),
  );
};

export const createFill = (
  input: Fill,
): Result<Fill, TradingValidationError> => {
  if (
    !isNonEmpty(input.fillId) ||
    !isNonEmpty(input.clientOrderId) ||
    !isNonEmpty(input.exchangeOrderId) ||
    !isPositiveFinite(input.price) ||
    !isPositiveFinite(input.quantity) ||
    !Number.isFinite(input.fee) ||
    input.fee < 0 ||
    !Number.isSafeInteger(input.executedAt) ||
    input.executedAt < 0
  ) {
    return err({ code: "INVALID_FILL" });
  }
  return ok(Object.freeze({ ...input }));
};

