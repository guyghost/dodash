import {
  createClientOrderId,
  createOrderIntent,
  err,
  ok,
  type OrderIntent,
  type ProductId,
  type Result,
  type Signal,
  type TradingValidationError,
} from "@dodash/domain";

export type ExecutionStyle = "MARKET" | "LIMIT_PASSIVE";

export interface OrderBookTop {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly spreadBps: number;
}

export interface AllocationInput {
  readonly agentId: string;
  readonly cycleId: string;
  readonly decisionId: string;
  readonly signals: readonly Signal[];
  readonly marketPrices: Readonly<Record<string, number>>;
  readonly capitalAvailable: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly executionStyle?: ExecutionStyle;
  readonly orderBooks?: Readonly<Record<string, OrderBookTop>>;
  readonly maxSpreadBps?: number;
  readonly positionQuantities?: Readonly<Record<string, number>>;
  readonly closeFullPositionOnSell?: boolean;
  readonly allowShort?: boolean;
}

export interface AllocationDecision {
  readonly decisionId: string;
  readonly outcome: "NO_ACTION" | "ALLOCATED";
  readonly orders: readonly OrderIntent[];
  readonly netQuantities: Readonly<Record<string, number>>;
}

export type AllocationError =
  | { readonly code: "INVALID_ALLOCATION_CONFIG" }
  | { readonly code: "MISSING_MARKET_PRICE"; readonly productId: string }
  | { readonly code: "INVALID_CLIENT_ORDER_ID"; readonly cause: TradingValidationError }
  | { readonly code: "INVALID_ORDER_INTENT"; readonly cause: TradingValidationError };

interface ProductSignals {
  readonly productId: ProductId;
  readonly signals: Signal[];
}

const validInput = (input: AllocationInput): boolean =>
  input.agentId.trim().length > 0 &&
  input.cycleId.trim().length > 0 &&
  input.decisionId.trim().length > 0 &&
  Number.isFinite(input.capitalAvailable) &&
  input.capitalAvailable >= 0 &&
  Number.isFinite(input.maxDecisionNotional) &&
  input.maxDecisionNotional > 0 &&
  Number.isFinite(input.minNetQuantity) &&
  input.minNetQuantity >= 0 &&
  (input.executionStyle === undefined ||
    input.executionStyle === "MARKET" ||
    input.executionStyle === "LIMIT_PASSIVE") &&
  (input.maxSpreadBps === undefined ||
    (Number.isFinite(input.maxSpreadBps) && input.maxSpreadBps >= 0));

const isSpreadBlocked = (
  book: OrderBookTop | undefined,
  maxSpreadBps: number | undefined,
): boolean =>
  maxSpreadBps !== undefined &&
  book !== undefined &&
  (!Number.isFinite(book.spreadBps) ||
    book.spreadBps < 0 ||
    book.spreadBps > maxSpreadBps);

const isValidBookForLimit = (book: OrderBookTop | undefined): book is OrderBookTop =>
  book !== undefined &&
  Number.isFinite(book.bestBid) &&
  book.bestBid > 0 &&
  Number.isFinite(book.bestAsk) &&
  book.bestAsk >= book.bestBid;

const resolveOrderExecution = (
  executionStyle: ExecutionStyle | undefined,
  book: OrderBookTop | undefined,
  side: "BUY" | "SELL",
): { readonly type: "MARKET" | "LIMIT"; readonly limitPrice: number | null } => {
  if (executionStyle === "LIMIT_PASSIVE" && isValidBookForLimit(book)) {
    return {
      type: "LIMIT",
      limitPrice: side === "BUY" ? book.bestBid : book.bestAsk,
    };
  }
  return { type: "MARKET", limitPrice: null };
};

export const allocateSignals = (
  input: AllocationInput,
): Result<AllocationDecision, AllocationError> => {
  if (!validInput(input)) return err({ code: "INVALID_ALLOCATION_CONFIG" });

  const groups = new Map<string, ProductSignals>();
  for (const signal of input.signals) {
    if (signal.side === "HOLD") continue;
    const key = signal.productId as string;
    const group = groups.get(key) ?? { productId: signal.productId, signals: [] };
    group.signals.push(signal);
    groups.set(key, group);
  }

  const netQuantities: Record<string, number> = {};
  const orders: OrderIntent[] = [];
  let remainingNotional = Math.min(
    input.capitalAvailable,
    input.maxDecisionNotional,
  );

  for (const productKey of [...groups.keys()].sort()) {
    const group = groups.get(productKey);
    if (group === undefined) continue;
    const price = input.marketPrices[productKey];
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      return err({ code: "MISSING_MARKET_PRICE", productId: productKey });
    }

    const net = group.signals.reduce(
      (total, signal) =>
        total +
        (signal.side === "BUY" ? 1 : -1) *
          signal.suggestedSize *
          signal.confidence,
      0,
    );
    netQuantities[productKey] = net;
    const heldQty = input.positionQuantities?.[productKey];
    const hasHeld = heldQty !== undefined && Number.isFinite(heldQty);
    const allowShort = input.allowShort === true;
    const isClosingLong = net < 0 && hasHeld && (allowShort ? heldQty > input.minNetQuantity : true);
    const isClosingShort = allowShort && net > 0 && hasHeld && heldQty < -input.minNetQuantity;
    const isClosingOrder = isClosingLong || isClosingShort;
    const isPyramidingLong =
      net > 0 &&
      input.closeFullPositionOnSell === true &&
      hasHeld &&
      heldQty > input.minNetQuantity;
    const isPyramidingShort =
      allowShort &&
      net < 0 &&
      input.closeFullPositionOnSell === true &&
      hasHeld &&
      heldQty < -input.minNetQuantity;

    if (isClosingLong) {
      if (heldQty <= input.minNetQuantity) continue;
    } else if (isClosingShort) {
      if (Math.abs(heldQty) <= input.minNetQuantity) continue;
    } else if (
      isPyramidingLong ||
      isPyramidingShort ||
      Math.abs(net) <= input.minNetQuantity ||
      remainingNotional <= 0
    ) {
      continue;
    }

    const book = input.orderBooks?.[productKey];
    if (isSpreadBlocked(book, input.maxSpreadBps)) continue;

    const heldAbs = hasHeld ? Math.abs(heldQty) : 0;
    const quantity = isClosingOrder
      ? input.closeFullPositionOnSell === true
        ? heldAbs
        : Math.min(Math.abs(net), heldAbs)
      : Math.min(Math.abs(net), remainingNotional / price);
    if (quantity <= input.minNetQuantity) continue;
    const clientOrderId = createClientOrderId(
      input.agentId,
      input.cycleId,
      input.decisionId,
      orders.length,
    );
    if (!clientOrderId.ok) {
      return err({ code: "INVALID_CLIENT_ORDER_ID", cause: clientOrderId.error });
    }

    const side = net > 0 ? "BUY" : "SELL";
    const { type, limitPrice } = resolveOrderExecution(
      input.executionStyle,
      book,
      side,
    );
    const contributors = group.signals
      .filter((signal) => signal.side === side)
      .map((signal) => signal.strategyId)
      .sort();
    const intent = createOrderIntent({
      clientOrderId: clientOrderId.value,
      decisionId: input.decisionId,
      strategyIds: contributors,
      productId: group.productId,
      side,
      type,
      quantity,
      limitPrice,
    });
    if (!intent.ok) {
      return err({ code: "INVALID_ORDER_INTENT", cause: intent.error });
    }
    orders.push(intent.value);
    if (!isClosingOrder) {
      remainingNotional -= quantity * price;
    }
  }

  return ok(
    Object.freeze({
      decisionId: input.decisionId,
      outcome: orders.length === 0 ? ("NO_ACTION" as const) : ("ALLOCATED" as const),
      orders: Object.freeze(orders),
      netQuantities: Object.freeze(netQuantities),
    }),
  );
};

