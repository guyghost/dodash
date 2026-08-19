import { allocateSignals, type AllocationError } from "@dodash/allocator";
import {
  createOrderIntent,
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
  requiredIndicatorCandles,
  type IndicatorConfig,
  type IndicatorError,
  type IndicatorSnapshot,
} from "@dodash/indicators-prolog";
import {
  createExecutionSchedule,
  isValidProtectiveExitPolicy,
  protectiveOrderMachine,
  type ActiveProtectiveExitPolicy,
  type ExecutionScheduleError,
  type ProtectiveExitPolicy,
  type ProtectiveExitResolution,
} from "@dodash/models";
import { checkRisk, type RiskConfig, type RiskError } from "@dodash/risk";
import type { StrategyError, StrategyRegistry } from "@dodash/strategies";
import { createActor, type ActorRefFrom } from "xstate";

import { calculateMetrics, type BacktestMetrics, type EquityPoint } from "./metrics.js";
import {
  executePaperOrder,
  type PaperBrokerConfig,
  type PaperBrokerError,
  type PaperPortfolio,
  type PaperTrade,
} from "./paper-broker.js";
import type { PreparedBacktestIndicators } from "./prepared-indicators.js";

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
  readonly protectiveExit?: ProtectiveExitPolicy;
}

export interface BacktestReplayOptions {
  readonly executionCandles?: readonly Candle[];
}

export interface ProtectiveExitExecution extends ProtectiveExitResolution {
  readonly positionId: string;
  readonly quantity: number;
  readonly fillId: string;
  readonly fillPrice: number;
}

export interface BacktestResult {
  readonly runId: string;
  readonly trades: readonly PaperTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
  readonly finalPortfolio: PaperPortfolio;
  readonly processedCandles: number;
  readonly protectiveExits: readonly ProtectiveExitExecution[];
}

export type BacktestReplayError =
  | { readonly code: "INVALID_BACKTEST_CONFIG" }
  | { readonly code: "INVALID_CANDLES"; readonly cause: MarketValidationError }
  | {
      readonly code: "INVALID_EXECUTION_CANDLES";
      readonly cause: MarketValidationError | ExecutionScheduleError;
    }
  | { readonly code: "INVALID_PREPARED_INDICATORS" }
  | { readonly code: "INDICATOR_FAILURE"; readonly cause: IndicatorError }
  | { readonly code: "STRATEGY_FAILURE"; readonly cause: StrategyError }
  | { readonly code: "ALLOCATION_FAILURE"; readonly cause: AllocationError }
  | { readonly code: "RISK_FAILURE"; readonly cause: RiskError }
  | { readonly code: "BROKER_FAILURE"; readonly cause: PaperBrokerError }
  | { readonly code: "PROTECTIVE_ORDER_FAILURE"; readonly cause: unknown };

const validProtectivePolicy = (policy: ProtectiveExitPolicy | undefined): boolean =>
  policy === undefined ||
  policy.mode === "NONE" ||
  isValidProtectiveExitPolicy(policy);

const validConfig = (config: BacktestConfig): boolean =>
  config.runId.trim().length > 0 &&
  config.agentId.trim().length > 0 &&
  Number.isFinite(config.initialCapital) &&
  config.initialCapital > 0 &&
  Number.isFinite(config.maxDecisionNotional) &&
  config.maxDecisionNotional > 0 &&
  Number.isFinite(config.minNetQuantity) &&
  config.minNetQuantity >= 0 &&
  validProtectivePolicy(config.protectiveExit);

const validPreparedIndicators = (
  prepared: PreparedBacktestIndicators,
  candles: readonly Candle[],
  config: IndicatorConfig,
  warmup: number,
): boolean =>
  prepared.config.rsiPeriod === config.rsiPeriod &&
  prepared.config.emaFastPeriod === config.emaFastPeriod &&
  prepared.config.emaSlowPeriod === config.emaSlowPeriod &&
  prepared.config.atrPeriod === config.atrPeriod &&
  prepared.config.historicalVolatilityPeriod ===
    config.historicalVolatilityPeriod &&
  prepared.config.momentumPeriod === config.momentumPeriod &&
  prepared.config.returnPeriods.length === config.returnPeriods.length &&
  prepared.config.returnPeriods.every(
    (period, index) => period === config.returnPeriods[index],
  ) &&
  prepared.config.vwapPeriod === config.vwapPeriod &&
  prepared.config.relativeVolumePeriod === config.relativeVolumePeriod &&
  prepared.config.volumeSpikeThreshold === config.volumeSpikeThreshold &&
  prepared.config.volumeTrendPeriod === config.volumeTrendPeriod &&
  prepared.config.trendStrengthPeriod === config.trendStrengthPeriod &&
  prepared.snapshots.length === candles.length &&
  prepared.snapshots.every((snapshot, index) =>
    index < warmup - 1
      ? snapshot === null
      : snapshot !== null && snapshot.candleClosedAt === candles[index]?.start,
  );

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
  preparedIndicators?: PreparedBacktestIndicators,
  options?: BacktestReplayOptions,
): Promise<Result<BacktestResult, BacktestReplayError>> => {
  if (!validConfig(config)) return err({ code: "INVALID_BACKTEST_CONFIG" });
  const validated = validateCandleSeries(candles);
  if (!validated.ok) return err({ code: "INVALID_CANDLES", cause: validated.error });
  const validatedExecution =
    options?.executionCandles === undefined
      ? undefined
      : validateCandleSeries(options.executionCandles);
  if (validatedExecution !== undefined && !validatedExecution.ok) {
    return err({
      code: "INVALID_EXECUTION_CANDLES",
      cause: validatedExecution.error,
    });
  }
  const executionSchedule = createExecutionSchedule(
    validated.value,
    validatedExecution?.value,
  );
  if (!executionSchedule.ok) {
    return err({
      code: "INVALID_EXECUTION_CANDLES",
      cause: executionSchedule.error,
    });
  }

  const warmup = requiredIndicatorCandles(config.indicators);
  if (
    preparedIndicators !== undefined &&
    !validPreparedIndicators(
      preparedIndicators,
      validated.value,
      config.indicators,
      warmup,
    )
  ) {
    return err({ code: "INVALID_PREPARED_INDICATORS" });
  }
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
  const protectivePolicy = config.protectiveExit ?? ({ mode: "NONE" } as const);
  const activeProtectivePolicy: ActiveProtectiveExitPolicy | null =
    protectivePolicy.mode === "NONE" ? null : protectivePolicy;
  type ProtectiveActor = ActorRefFrom<typeof protectiveOrderMachine>;
  const protectiveState: { actor: ProtectiveActor | null } = { actor: null };
  let protectivePositionSequence = 0;
  const protectiveExits: ProtectiveExitExecution[] = [];

  const actorFailure = (): BacktestReplayError | null => {
    const actor = protectiveState.actor;
    if (actor?.getSnapshot().matches("failed")) {
      return {
        code: "PROTECTIVE_ORDER_FAILURE",
        cause:
          actor.getSnapshot().context.lastError ??
          ({ code: "INVALID_PROTECTIVE_SEQUENCE" } as const),
      };
    }
    return null;
  };

  const executeTriggeredProtectiveExit = (
    candle: Candle,
  ): BacktestReplayError | null => {
    const actor = protectiveState.actor;
    if (actor === null) return null;
    const snapshot = actor.getSnapshot();
    if (snapshot.matches("failed")) return actorFailure();
    if (!snapshot.matches("triggered")) return null;
    const resolution = snapshot.context.resolution;
    const plan = snapshot.context.plan;
    if (
      resolution === null ||
      plan === null ||
      portfolio.positionQuantity <= 0
    ) {
      return {
        code: "PROTECTIVE_ORDER_FAILURE",
        cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
      };
    }
    const quantity = portfolio.positionQuantity;
    const intent = createOrderIntent({
      clientOrderId: `${config.runId}:protective:${protectivePositionSequence}:${candle.start}`,
      decisionId: `${config.runId}:protective:${candle.start}`,
      strategyIds: [`protective-${resolution.kind.toLowerCase()}`],
      productId: config.productId,
      side: "SELL",
      type: "MARKET",
      quantity,
      limitPrice: null,
    });
    if (!intent.ok) {
      return { code: "PROTECTIVE_ORDER_FAILURE", cause: intent.error };
    }
    const execution = executePaperOrder(
      portfolio,
      intent.value,
      resolution.referencePrice,
      candle.start,
      config.broker,
    );
    if (!execution.ok) {
      return { code: "BROKER_FAILURE", cause: execution.error };
    }
    portfolio = execution.value.portfolio;
    trades.push(execution.value.trade);
    lastTradeAt = candle.start;
    protectiveExits.push(
      Object.freeze({
        ...resolution,
        positionId: plan.positionId,
        quantity,
        fillId: execution.value.trade.fill.fillId,
        fillPrice: execution.value.trade.fill.price,
      }),
    );
    protectiveState.actor = null;
    return null;
  };

  const armProtectivePosition = (
    candle: Candle,
    atr: number | null,
  ): BacktestReplayError | null => {
    if (activeProtectivePolicy === null || portfolio.positionQuantity <= 0) {
      return null;
    }
    protectivePositionSequence += 1;
    const actor = createActor(protectiveOrderMachine, {
      input: { policy: activeProtectivePolicy },
    }).start();
    actor.send({
      type: "ARM_REQUESTED",
      positionId: `${config.runId}:position:${protectivePositionSequence}`,
      quantity: portfolio.positionQuantity,
      averageEntryPrice: portfolio.averagePrice,
      atr,
      armedAt: candle.start,
    });
    protectiveState.actor = actor;
    const failure = actorFailure();
    if (failure !== null) return failure;
    actor.send({ type: "CANDLE_OPENED", start: candle.start, open: candle.open });
    return actorFailure() ?? executeTriggeredProtectiveExit(candle);
  };

  for (let index = 0; index < validated.value.length; index += 1) {
    const candle = validated.value[index];
    if (candle === undefined) continue;
    const executionBucket = executionSchedule.value.buckets[index];
    if (executionBucket === undefined) {
      return err({
        code: "INVALID_EXECUTION_CANDLES",
        cause: { code: "MISALIGNED_EXECUTION_RANGE" },
      });
    }

    for (const [executionIndex, executionCandle] of
      executionBucket.executionCandles.entries()) {
      const actorAtOpen = protectiveState.actor;
      if (actorAtOpen !== null) {
        if (!actorAtOpen.getSnapshot().matches({ armed: "awaitingOpen" })) {
          return err({
            code: "PROTECTIVE_ORDER_FAILURE",
            cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
          });
        }
        actorAtOpen.send({
          type: "CANDLE_OPENED",
          start: executionCandle.start,
          open: executionCandle.open,
        });
        const failure =
          actorFailure() ?? executeTriggeredProtectiveExit(executionCandle);
        if (failure !== null) return err(failure);
      }

      if (executionIndex === 0) {
        for (const pendingOrder of pendingOrders) {
          const positionBefore = portfolio.positionQuantity;
          const order = capSpotOrder(
            pendingOrder,
            portfolio,
            executionCandle.open,
            config.broker,
            config.minNetQuantity,
          );
          if (order === null) continue;
          const execution = executePaperOrder(
            portfolio,
            order,
            executionCandle.open,
            executionCandle.start,
            config.broker,
          );
          if (!execution.ok) {
            return err({ code: "BROKER_FAILURE", cause: execution.error });
          }
          portfolio = execution.value.portfolio;
          trades.push(execution.value.trade);
          lastTradeAt = executionCandle.start;

          if (activeProtectivePolicy !== null) {
            const positionAfter = portfolio.positionQuantity;
            const tolerance =
              Math.max(1, Math.abs(positionBefore), Math.abs(positionAfter)) *
              Number.EPSILON *
              16;
            if (positionAfter === 0) {
              const actorToCancel = protectiveState.actor;
              if (actorToCancel !== null) {
                actorToCancel.send({
                  type: "CANCEL_REQUESTED",
                  reason: "POSITION_CLOSED",
                });
                if (!actorToCancel.getSnapshot().matches("cancelled")) {
                  return err({
                    code: "PROTECTIVE_ORDER_FAILURE",
                    cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
                  });
                }
                protectiveState.actor = null;
              }
            } else if (positionAfter > positionBefore + tolerance) {
              const actorToIncrease = protectiveState.actor;
              if (actorToIncrease === null) {
                const failure = armProtectivePosition(
                  executionCandle,
                  previousIndicators?.atr ?? null,
                );
                if (failure !== null) return err(failure);
              } else {
                actorToIncrease.send({
                  type: "POSITION_INCREASED",
                  quantity: positionAfter,
                  averageEntryPrice: portfolio.averagePrice,
                  atr: previousIndicators?.atr ?? null,
                  updatedAt: executionCandle.start,
                });
                const failure = actorFailure();
                if (failure !== null) return err(failure);
              }
            } else if (positionAfter < positionBefore - tolerance) {
              const actorToReduce = protectiveState.actor;
              if (actorToReduce === null) {
                return err({
                  code: "PROTECTIVE_ORDER_FAILURE",
                  cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
                });
              }
              actorToReduce.send({
                type: "POSITION_REDUCED",
                quantity: positionAfter,
                updatedAt: executionCandle.start,
              });
              const failure = actorFailure();
              if (failure !== null) return err(failure);
            }
          }
        }
        pendingOrders = [];
      }

      const actorAtRange = protectiveState.actor;
      if (actorAtRange !== null) {
        if (!actorAtRange.getSnapshot().matches({ armed: "awaitingRange" })) {
          return err({
            code: "PROTECTIVE_ORDER_FAILURE",
            cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
          });
        }
        actorAtRange.send({
          type: "CANDLE_RANGE_REPLAYED",
          start: executionCandle.start,
          high: executionCandle.high,
          low: executionCandle.low,
        });
        const failure =
          actorFailure() ?? executeTriggeredProtectiveExit(executionCandle);
        if (failure !== null) return err(failure);
      }
    }

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
    const preparedSnapshot = preparedIndicators?.snapshots[index];
    const indicatorResult =
      preparedSnapshot === undefined || preparedSnapshot === null
        ? await computeIndicators(history, config.indicators)
        : ok(preparedSnapshot);
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
      protectiveExits: Object.freeze(protectiveExits),
    }),
  );
};
