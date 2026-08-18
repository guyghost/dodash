import {
  createFill,
  err,
  ok,
  type Fill,
  type OrderIntent,
  type Result,
} from "@dodash/domain";

export interface PaperBrokerConfig {
  readonly feeBps: number;
  readonly slippageBps: number;
}

export interface PaperPortfolio {
  readonly cash: number;
  readonly positionQuantity: number;
  readonly averagePrice: number;
}

export interface PaperTrade {
  readonly fill: Fill;
  readonly realizedPnl: number;
}

export interface PaperExecution {
  readonly portfolio: PaperPortfolio;
  readonly trade: PaperTrade;
}

export type PaperBrokerError =
  | { readonly code: "INVALID_BROKER_CONFIG" }
  | { readonly code: "INVALID_MARKET_PRICE" }
  | { readonly code: "INVALID_FILL_RESULT" };

const validConfig = (config: PaperBrokerConfig): boolean =>
  Number.isFinite(config.feeBps) &&
  config.feeBps >= 0 &&
  config.feeBps < 10_000 &&
  Number.isFinite(config.slippageBps) &&
  config.slippageBps >= 0 &&
  config.slippageBps < 10_000;

export const executePaperOrder = (
  portfolio: PaperPortfolio,
  intent: OrderIntent,
  marketPrice: number,
  executedAt: number,
  config: PaperBrokerConfig,
): Result<PaperExecution, PaperBrokerError> => {
  if (!validConfig(config)) return err({ code: "INVALID_BROKER_CONFIG" });
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return err({ code: "INVALID_MARKET_PRICE" });
  }

  const direction = intent.side === "BUY" ? 1 : -1;
  const price = marketPrice * (1 + direction * (config.slippageBps / 10_000));
  const fee = price * intent.quantity * (config.feeBps / 10_000);
  const fill = createFill({
    fillId: `paper:${intent.clientOrderId}:${executedAt}`,
    clientOrderId: intent.clientOrderId,
    exchangeOrderId: `paper:${intent.clientOrderId}`,
    price,
    quantity: intent.quantity,
    fee,
    executedAt,
  });
  if (!fill.ok) return err({ code: "INVALID_FILL_RESULT" });

  const current = portfolio.positionQuantity;
  const delta = direction * intent.quantity;
  const sameDirection = current === 0 || Math.sign(current) === Math.sign(delta);
  const closedQuantity = sameDirection
    ? 0
    : Math.min(Math.abs(current), Math.abs(delta));
  const grossRealized =
    closedQuantity === 0
      ? 0
      : current > 0
        ? (price - portfolio.averagePrice) * closedQuantity
        : (portfolio.averagePrice - price) * closedQuantity;
  const realizedPnl = grossRealized - fee;
  const nextQuantity = current + delta;

  let averagePrice = portfolio.averagePrice;
  if (sameDirection) {
    averagePrice =
      nextQuantity === 0
        ? 0
        : (Math.abs(current) * portfolio.averagePrice + Math.abs(delta) * price) /
          Math.abs(nextQuantity);
  } else if (nextQuantity === 0) {
    averagePrice = 0;
  } else if (Math.sign(nextQuantity) !== Math.sign(current)) {
    averagePrice = price;
  }

  const cashDelta = intent.side === "BUY"
    ? -(price * intent.quantity + fee)
    : price * intent.quantity - fee;
  return ok(
    Object.freeze({
      portfolio: Object.freeze({
        cash: portfolio.cash + cashDelta,
        positionQuantity: nextQuantity,
        averagePrice,
      }),
      trade: Object.freeze({ fill: fill.value, realizedPnl }),
    }),
  );
};

