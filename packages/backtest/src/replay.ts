import { allocateSignals, type AllocationError } from "@dodash/allocator";
import {
  err,
  ok,
  validateCandleSeries,
  type Candle,
  type MarketValidationError,
  type OrderIntent,
  type ProductId,
  type Result,
} from "@dodash/domain";
import {
  computeIndicators,
  type IndicatorConfig,
  type IndicatorError,
  type IndicatorSnapshot,
} from "@dodash/indicators-prolog";
import { checkRisk, type RiskConfig, type RiskError } from "@dodash/risk";
import type { StrategyError, StrategyRegistry } from "@dodash/strategies";

import { calculateMetrics, type BacktestMetrics, type EquityPoint } from "./metrics.js";
import {
  executePaperOrder,
  type PaperBrokerConfig,
  type PaperBrokerError,
  type PaperPortfolio,
  type PaperTrade,
} from "./paper-broker.js";

export interface BacktestConfig {
  readonly runId: string;
  readonly agentId: string;
  readonly productId: ProductId;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly indicators: IndicatorConfig;
  readonly strategies: StrategyRegistry;
  readonly risk: RiskConfig;
  readonly broker: PaperBrokerConfig;
}

export interface BacktestResult {
  readonly runId: string;
  readonly trades: readonly PaperTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
  readonly finalPortfolio: PaperPortfolio;
  readonly processedCandles: number;
}

export type BacktestReplayError =
  | { readonly code: "INVALID_BACKTEST_CONFIG" }
  | { readonly code: "INVALID_CANDLES"; readonly cause: MarketValidationError }
  | { readonly code: "INDICATOR_FAILURE"; readonly cause: IndicatorError }
  | { readonly code: "STRATEGY_FAILURE"; readonly cause: StrategyError }
  | { readonly code: "ALLOCATION_FAILURE"; readonly cause: AllocationError }
  | { readonly code: "RISK_FAILURE"; readonly cause: RiskError }
  | { readonly code: "BROKER_FAILURE"; readonly cause: PaperBrokerError };

const validConfig = (config: BacktestConfig): boolean =>
  config.runId.trim().length > 0 &&
  config.agentId.trim().length > 0 &&
  Number.isFinite(config.initialCapital) &&
  config.initialCapital > 0 &&
  Number.isFinite(config.maxDecisionNotional) &&
  config.maxDecisionNotional > 0 &&
  Number.isFinite(config.minNetQuantity) &&
  config.minNetQuantity >= 0;

const capSpotOrder = (
  order: OrderIntent,
  portfolio: PaperPortfolio,
  marketPrice: number,
  broker: PaperBrokerConfig,
  minNetQuantity: number,
): OrderIntent | null => {
  const direction = order.side === "BUY" ? 1 : -1;
  const executionPrice =
    marketPrice * (1 + direction * (broker.slippageBps / 10_000));
  const feeRate = broker.feeBps / 10_000;
  const availableQuantity =
    order.side === "BUY"
      ? portfolio.cash / (executionPrice * (1 + feeRate))
      : Math.max(0, portfolio.positionQuantity);
  const quantity = Math.min(order.quantity, availableQuantity);
  if (!Number.isFinite(quantity) || quantity <= minNetQuantity) return null;
  return quantity === order.quantity
    ? order
    : Object.freeze({ ...order, quantity });
};

export const replayBacktest = async (
  candles: readonly Candle[],
  config: BacktestConfig,
): Promise<Result<BacktestResult, BacktestReplayError>> => {
  if (!validConfig(config)) return err({ code: "INVALID_BACKTEST_CONFIG" });
  const validated = validateCandleSeries(candles);
  if (!validated.ok) return err({ code: "INVALID_CANDLES", cause: validated.error });

  const warmup = Math.max(
    config.indicators.rsiPeriod + 1,
    config.indicators.emaSlowPeriod,
    config.indicators.atrPeriod,
  );
  let portfolio: PaperPortfolio = {
    cash: config.initialCapital,
    positionQuantity: 0,
    averagePrice: 0,
  };
  const trades: PaperTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let previousIndicators: IndicatorSnapshot | null = null;
  let lastTradeAt: number | null = null;
  let pendingOrders: readonly OrderIntent[] = [];

  for (let index = 0; index < validated.value.length; index += 1) {
    const candle = validated.value[index];
    if (candle === undefined) continue;

    for (const pendingOrder of pendingOrders) {
      const order = capSpotOrder(
        pendingOrder,
        portfolio,
        candle.open,
        config.broker,
        config.minNetQuantity,
      );
      if (order === null) continue;
      const execution = executePaperOrder(
        portfolio,
        order,
        candle.open,
        candle.start,
        config.broker,
      );
      if (!execution.ok) {
        return err({ code: "BROKER_FAILURE", cause: execution.error });
      }
      portfolio = execution.value.portfolio;
      trades.push(execution.value.trade);
      lastTradeAt = candle.start;
    }
    pendingOrders = [];

    if (index < warmup - 1) {
      equityCurve.push(
        Object.freeze({
          at: candle.start,
          equity: portfolio.cash + portfolio.positionQuantity * candle.close,
        }),
      );
      continue;
    }

    const history = validated.value.slice(0, index + 1);
    const indicatorResult = await computeIndicators(history, config.indicators);
    if (!indicatorResult.ok) {
      return err({ code: "INDICATOR_FAILURE", cause: indicatorResult.error });
    }

    const signalResult = config.strategies.evaluateAll({
      productId: config.productId,
      candles: history,
      indicators: indicatorResult.value,
      previousIndicators,
    });
    if (!signalResult.ok) {
      return err({ code: "STRATEGY_FAILURE", cause: signalResult.error });
    }

    const allocation = allocateSignals({
      agentId: config.agentId,
      cycleId: `${config.runId}:${candle.start}`,
      decisionId: `${config.runId}:decision:${candle.start}`,
      signals: signalResult.value,
      marketPrices: { [config.productId]: candle.close },
      capitalAvailable: Math.max(0, portfolio.cash),
      maxDecisionNotional: config.maxDecisionNotional,
      minNetQuantity: config.minNetQuantity,
    });
    if (!allocation.ok) {
      return err({ code: "ALLOCATION_FAILURE", cause: allocation.error });
    }

    const approvedOrders: OrderIntent[] = [];
    for (const order of allocation.value.orders) {
      const equityBefore = portfolio.cash + portfolio.positionQuantity * candle.close;
      const risk = checkRisk(
        order,
        {
          marketPrice: candle.close,
          currentPositionQuantity: portfolio.positionQuantity,
          otherExposureNotional: 0,
          dailyPnl: equityBefore - config.initialCapital,
          lastTradeAt,
          now: candle.start,
          killSwitchActive: false,
        },
        config.risk,
      );
      if (!risk.ok) return err({ code: "RISK_FAILURE", cause: risk.error });
      if (risk.value.status === "REJECTED") continue;
      approvedOrders.push(order);
    }
    pendingOrders = Object.freeze(approvedOrders);

    equityCurve.push(
      Object.freeze({
        at: candle.start,
        equity: portfolio.cash + portfolio.positionQuantity * candle.close,
      }),
    );
    previousIndicators = indicatorResult.value;
  }

  const metrics = calculateMetrics(equityCurve, trades, config.initialCapital);
  return ok(
    Object.freeze({
      runId: config.runId,
      trades: Object.freeze(trades),
      equityCurve: Object.freeze(equityCurve),
      metrics,
      finalPortfolio: Object.freeze({ ...portfolio }),
      processedCandles: validated.value.length,
    }),
  );
};
