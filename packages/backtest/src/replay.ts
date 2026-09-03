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
  activeProtectivePolicyEquals,
  calibrateConfidence,
  createExecutionSchedule,
  extractBacktestDiagnosticSamples,
  isCalibratedStrategyId,
  isValidProtectiveExitPolicy,
  isValidRegimeConditionalExitPolicy,
  isValidRegimeConditionalSizingPolicy,
  isValidRegimeFilterPolicy,
  isValidRegimePermissions,
  DEFAULT_REGIME_PERMISSIONS,
  protectiveOrderMachine,
  resolveDailyRiskWindow,
  resolveRegimeExitArm,
  resolveRegimePermission,
  resolveRegimeSizingProfile,
  resolveRiskEvaluationTimestamp,
  resolveSpotPermission,
  regimeFilterMachine,
  summarizeBacktestDiagnostics,
  type ActiveProtectiveExitPolicy,
  type DailyRiskWindow,
  type AllocationDiagnosticObservation,
  type BacktestDiagnosticSamples,
  type BacktestDiagnostics,
  type BacktestDiagnosticsError,
  type ExecutionScheduleError,
  type ProtectiveExitPolicy,
  type ProtectiveExitResolution,
  type RegimeConditionalSizingPolicy,
  type RegimeFilterPolicy,
  type RegimeKind,
  type RegimePermissions,
  type RiskRejectionReasonCode,
  type SignalDiagnosticObservation,
  type SpotPermissionError,
} from "@dodash/models";
import {
  checkRisk,
  type RiskConfig,
  type RiskError,
  type RiskReasonCode,
} from "@dodash/risk";
import type { StrategyError, StrategyRegistry } from "@dodash/strategies";
import { createActor, type ActorRefFrom } from "xstate";

import { calculateMetrics, type BacktestMetrics, type EquityPoint } from "./metrics.js";

// INV (models/risk-rejection-diagnosis.md) : l'union miroir du modèle et
// RiskReasonCode de @dodash/risk doivent rester alignées — verrou compilation.
type RiskReasonCodesAligned = [RiskReasonCode] extends [RiskRejectionReasonCode]
  ? [RiskRejectionReasonCode] extends [RiskReasonCode]
    ? true
    : never
  : never;
// biome-ignore lint/correctness/noUnusedVariables: verrou de compilation intentionnel, jamais référencé
type RiskReasonCodesLock = RiskReasonCodesAligned extends true ? true : never;
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
  readonly regimeFilter?: RegimeFilterPolicy;
  // INV-S2 (models/regime-sizing.md) : nécessite regimeFilter. La
  // moitié confidenceCalibration de l'invariant est vérifiée côté suite.
  readonly regimeConditionalSizing?: RegimeConditionalSizingPolicy;
  // INV-P1..P3 (models/strategy-permission.md) : table de permission
  // optionnelle ; absente ⇒ DEFAULT_REGIME_PERMISSIONS (bit-exact V1).
  // Nécessite regimeFilter (la permission n'a de sens que si un régime
  // est observé).
  readonly regimePermissions?: RegimePermissions;
}

export interface RegimeGatingSummary {
  readonly policy: RegimeFilterPolicy;
  readonly finalRegime: RegimeKind | null;
  readonly observationsFed: number;
  readonly signalsPassed: number;
  readonly signalsFiltered: number;
  readonly deniedByStrategy: Readonly<Record<string, number>>;
  // INV-P6 (models/strategy-permission.md §10) : compteurs par régime
  // de DÉCISION (grandeur que le gate contrôle). Les décisions warm-up
  // (activeRegime null) ne rentrent dans aucun régime — elles restent
  // dans deniedByStrategy/signalsFiltered. Compteurs purs : aucun
  // effet sur les métriques.
  readonly passedByRegime: Readonly<Record<RegimeKind, number>>;
  readonly deniedByRegime: Readonly<Record<RegimeKind, number>>;
}

export interface BacktestReplayOptions {
  readonly executionCandles?: readonly Candle[];
  readonly includeDiagnosticSamples?: boolean;
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
  readonly diagnostics: BacktestDiagnostics;
  readonly diagnosticSamples: BacktestDiagnosticSamples | null;
  readonly regimeGating: RegimeGatingSummary | null;
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
  | {
      readonly code: "SPOT_PERMISSION_FAILURE";
      readonly cause: SpotPermissionError;
    }
  | { readonly code: "BROKER_FAILURE"; readonly cause: PaperBrokerError }
  | { readonly code: "PROTECTIVE_ORDER_FAILURE"; readonly cause: unknown }
  | { readonly code: "REGIME_FILTER_FAILURE" }
  | { readonly code: "REGIME_SIZING_FAILURE" }
  | { readonly code: "DIAGNOSTICS_FAILURE"; readonly cause: BacktestDiagnosticsError };

const validProtectivePolicy = (policy: ProtectiveExitPolicy | undefined): boolean => {
  if (policy === undefined || policy.mode === "NONE") return true;
  if (policy.mode === "REGIME_CONDITIONAL") {
    return isValidRegimeConditionalExitPolicy(policy);
  }
  return isValidProtectiveExitPolicy(policy);
};

const validConfig = (config: BacktestConfig): boolean =>
  config.runId.trim().length > 0 &&
  config.agentId.trim().length > 0 &&
  Number.isFinite(config.initialCapital) &&
  config.initialCapital > 0 &&
  Number.isFinite(config.maxDecisionNotional) &&
  config.maxDecisionNotional > 0 &&
  Number.isFinite(config.minNetQuantity) &&
  config.minNetQuantity >= 0 &&
  validProtectivePolicy(config.protectiveExit) &&
  (config.protectiveExit?.mode !== "REGIME_CONDITIONAL" ||
    config.regimeFilter !== undefined) &&
  (config.regimeFilter === undefined ||
    isValidRegimeFilterPolicy(config.regimeFilter)) &&
  (config.regimeConditionalSizing === undefined ||
    (isValidRegimeConditionalSizingPolicy(config.regimeConditionalSizing) &&
      config.regimeFilter !== undefined)) &&
  (config.regimePermissions === undefined ||
    (isValidRegimePermissions(config.regimePermissions) &&
      config.regimeFilter !== undefined));

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
  // INV-E1 (models/ema-signal-decoupling.md, correction review 1) : les
  // champs optionnels font partie de la comparaison — un prepared E0 ne
  // peut jamais alimenter un replay E1 (et réciproquement) sans rejet.
  prepared.config.signalEmaFastPeriod === config.signalEmaFastPeriod &&
  prepared.config.signalEmaSlowPeriod === config.signalEmaSlowPeriod &&
  prepared.snapshots.length === candles.length &&
  prepared.snapshots.every((snapshot, index) =>
    index < warmup - 1
      ? snapshot === null
      : snapshot !== null && snapshot.candleClosedAt === candles[index]?.start,
  );

// Réutilisé par le replay multi-produits (models/multi-product-portfolio.md
// §8) : plafonnement cash/position identique au replay mono-produit.
export const capSpotOrder = (
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
  let dailyRiskWindow: DailyRiskWindow | null = null;
  let pendingOrders: readonly OrderIntent[] = [];
  const protectivePolicy = config.protectiveExit ?? ({ mode: "NONE" } as const);
  let activeProtectivePolicy: ActiveProtectiveExitPolicy | null =
    protectivePolicy.mode === "NONE"
      ? null
      : protectivePolicy.mode === "REGIME_CONDITIONAL"
        ? resolveRegimeExitArm(protectivePolicy, null)
        : protectivePolicy;
  type ProtectiveActor = ActorRefFrom<typeof protectiveOrderMachine>;
  const protectiveState: { actor: ProtectiveActor | null } = { actor: null };
  let protectivePositionSequence = 0;
  const protectiveExits: ProtectiveExitExecution[] = [];
  const signalDiagnosticObservations: SignalDiagnosticObservation[] = [];
  const allocationDiagnosticObservations: AllocationDiagnosticObservation[] = [];
  const regimePolicy = config.regimeFilter ?? null;
  // INV-P1 : absente de la config, la table par défaut est utilisée —
  // bit-exact V1. INV-P3 : source unique models/, aucune table locale.
  const regimePermissions =
    config.regimePermissions ?? DEFAULT_REGIME_PERMISSIONS;
  const regimeActor =
    regimePolicy === null
      ? null
      : createActor(regimeFilterMachine, { input: { policy: regimePolicy } });
  regimeActor?.start();
  // INV-S2 garantit : sizing ⇒ regimeFilter ⇒ regimeActor ≠ null.
  const regimeConditionalSizing = config.regimeConditionalSizing ?? null;
  const regimeCounters = {
    observationsFed: 0,
    signalsPassed: 0,
    signalsFiltered: 0,
  };
  const deniedByStrategy = new Map<string, number>();
  const passedByRegime: Record<RegimeKind, number> = {
    BULLISH: 0,
    BEARISH: 0,
    RANGE: 0,
  };
  const deniedByRegime: Record<RegimeKind, number> = {
    BULLISH: 0,
    BEARISH: 0,
    RANGE: 0,
  };
  const countDenied = (strategyId: string): void => {
    regimeCounters.signalsFiltered += 1;
    deniedByStrategy.set(strategyId, (deniedByStrategy.get(strategyId) ?? 0) + 1);
  };

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

  const armProtectivePlan = (
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
    return actorFailure();
  };

  const armProtectivePosition = (
    candle: Candle,
    atr: number | null,
  ): BacktestReplayError | null => {
    const failure = armProtectivePlan(candle, atr);
    if (failure !== null) return failure;
    const actor = protectiveState.actor;
    if (actor === null) return null;
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
    for (const signal of signalResult.value) {
      signalDiagnosticObservations.push(
        Object.freeze({
          strategyId: signal.strategyId,
          side: signal.side,
          confidence: signal.confidence,
          suggestedSize: signal.suggestedSize,
          referencePrice: candle.close,
        }),
      );
    }

    let gatedSignals = signalResult.value;
    if (regimeActor !== null) {
      const indicatorSnapshot = indicatorResult.value;
      if (
        Number.isFinite(indicatorSnapshot.emaFast) &&
        indicatorSnapshot.emaFast > 0 &&
        Number.isFinite(indicatorSnapshot.emaSlow) &&
        indicatorSnapshot.emaSlow > 0
      ) {
        regimeActor.send({
          type: "CANDLE_CLOSED",
          observation: {
            start: indicatorSnapshot.candleClosedAt,
            emaFast: indicatorSnapshot.emaFast,
            emaSlow: indicatorSnapshot.emaSlow,
          },
        });
        regimeCounters.observationsFed += 1;
      }
      const regimeSnapshot = regimeActor.getSnapshot();
      if (regimeSnapshot.matches("failed")) {
        return err({ code: "REGIME_FILTER_FAILURE" });
      }
      const activeRegime = regimeSnapshot.context.regime;
      if (protectivePolicy.mode === "REGIME_CONDITIONAL") {
        const nextArm = resolveRegimeExitArm(protectivePolicy, activeRegime);
        if (!activeProtectivePolicyEquals(nextArm, activeProtectivePolicy)) {
          const existingActor = protectiveState.actor;
          if (existingActor !== null) {
            existingActor.send({
              type: "CANCEL_REQUESTED",
              reason: "REGIME_CHANGED",
            });
            if (!existingActor.getSnapshot().matches("cancelled")) {
              return err({
                code: "PROTECTIVE_ORDER_FAILURE",
                cause: { code: "INVALID_PROTECTIVE_SEQUENCE" },
              });
            }
            protectiveState.actor = null;
          }
          activeProtectivePolicy = nextArm;
          if (nextArm !== null && portfolio.positionQuantity > 0) {
            const failure = armProtectivePlan(
              candle,
              previousIndicators?.atr ?? null,
            );
            if (failure !== null) return err(failure);
          }
        }
      }
      const allowedSignals = [];
      for (const signal of signalResult.value) {
        const permission =
          activeRegime === null
            ? null
            : resolveRegimePermission(
                activeRegime,
                signal.strategyId,
                regimePermissions,
              );
        if (permission?.ok && permission.value) {
          allowedSignals.push(signal);
          regimeCounters.signalsPassed += 1;
          if (activeRegime !== null) passedByRegime[activeRegime] += 1;
        } else {
          countDenied(signal.strategyId);
          if (activeRegime !== null) deniedByRegime[activeRegime] += 1;
        }
      }
      gatedSignals = allowedSignals;
      // Sizing conditionné par régime (models/regime-sizing.md §3) :
      // recalibrage de la confiance des signaux autorisés entre le gate
      // et l'allocation (l'allocateur consomme confidence). INV-S1 :
      // bras IDENTITY court-circuité — aucun signal touché, bit-exact.
      // INV-S4 : HOLD et stratégies non calibrables inchangés.
      if (regimeConditionalSizing !== null) {
        const sizingProfile = resolveRegimeSizingProfile(
          regimeConditionalSizing,
          activeRegime,
        );
        if (sizingProfile !== "IDENTITY") {
          const recalibrated = [];
          for (const signal of gatedSignals) {
            if (
              signal.side === "HOLD" ||
              !isCalibratedStrategyId(signal.strategyId)
            ) {
              recalibrated.push(signal);
              continue;
            }
            const calibrated = calibrateConfidence(
              sizingProfile,
              signal.confidence,
            );
            if (!calibrated.ok) {
              return err({ code: "REGIME_SIZING_FAILURE" });
            }
            recalibrated.push({ ...signal, confidence: calibrated.value });
          }
          gatedSignals = recalibrated;
        }
      }
    }

    const allocation = allocateSignals({
      agentId: config.agentId,
      cycleId: `${config.runId}:${candle.start}`,
      decisionId: `${config.runId}:decision:${candle.start}`,
      signals: gatedSignals,
      marketPrices: { [config.productId]: candle.close },
      capitalAvailable: Math.max(0, portfolio.cash),
      maxDecisionNotional: config.maxDecisionNotional,
      minNetQuantity: config.minNetQuantity,
    });
    if (!allocation.ok) {
      return err({ code: "ALLOCATION_FAILURE", cause: allocation.error });
    }
    const requestedNetQuantity = Math.abs(
      allocation.value.netQuantities[config.productId] ?? 0,
    );
    const requestedNetNotional = requestedNetQuantity * candle.close;
    const allocatedNotional = allocation.value.orders.reduce(
      (total, order) => total + order.quantity * candle.close,
      0,
    );

    const approvedOrders: OrderIntent[] = [];
    const rejectedReasonCodes: RiskRejectionReasonCode[] = [];
    let spotInexecutableNotional = 0;
    // Fenêtre daily-risk (models/daily-pnl-fidelity.md INV-P1) : roulée à
    // chaque candle évalué, miroir du live qui roule à chaque cycle. En
    // ONE_DAY aligné UTC, chaque candle rouvre la fenêtre (INV-P3).
    const equityCandle = portfolio.cash + portfolio.positionQuantity * candle.close;
    const dailyRisk = resolveDailyRiskWindow(dailyRiskWindow, candle.start, equityCandle);
    dailyRiskWindow = dailyRisk.window;
    for (const order of allocation.value.orders) {
      // Pré-validation spot amont (models/spot-prevalidation.md) : un
      // ordre inexécutable est abandonné AVANT le risk engine et
      // n'entame jamais sa métrique de rejet.
      const permission = resolveSpotPermission(
        order.side,
        order.quantity,
        portfolio.positionQuantity,
      );
      if (!permission.ok) {
        return err({
          code: "SPOT_PERMISSION_FAILURE",
          cause: permission.error,
        });
      }
      if (permission.value.status === "INEXECUTABLE") {
        spotInexecutableNotional += order.quantity * candle.close;
        continue;
      }
      const risk = checkRisk(
        order,
        {
          marketPrice: candle.close,
          currentPositionQuantity: portfolio.positionQuantity,
          otherExposureNotional: 0,
          dailyPnl: dailyRisk.dailyPnl,
          lastTradeAt,
          now: resolveRiskEvaluationTimestamp(candle.start, lastTradeAt),
          killSwitchActive: false,
        },
        config.risk,
      );
      if (!risk.ok) return err({ code: "RISK_FAILURE", cause: risk.error });
      if (risk.value.status === "REJECTED") {
        rejectedReasonCodes.push(risk.value.reasonCode);
        continue;
      }
      approvedOrders.push(order);
    }
    if (requestedNetQuantity > config.minNetQuantity) {
      allocationDiagnosticObservations.push(
        Object.freeze({
          requestedNetNotional,
          allocatedNotional,
          spotInexecutableNotional,
          riskApprovedNotional: approvedOrders.reduce(
            (total, order) => total + order.quantity * candle.close,
            0,
          ),
          rejectedReasonCodes: Object.freeze(rejectedReasonCodes),
        }),
      );
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

  const diagnostics = summarizeBacktestDiagnostics(
    signalDiagnosticObservations,
    allocationDiagnosticObservations,
  );
  if (!diagnostics.ok) {
    return err({ code: "DIAGNOSTICS_FAILURE", cause: diagnostics.error });
  }
  const diagnosticSamples =
    options?.includeDiagnosticSamples === true
      ? extractBacktestDiagnosticSamples(signalDiagnosticObservations)
      : null;
  if (diagnosticSamples !== null && !diagnosticSamples.ok) {
    return err({
      code: "DIAGNOSTICS_FAILURE",
      cause: diagnosticSamples.error,
    });
  }
  const regimeGating: RegimeGatingSummary | null =
    regimeActor === null
      ? null
      : Object.freeze({
          policy: regimePolicy as RegimeFilterPolicy,
          finalRegime: regimeActor.getSnapshot().context.regime ?? null,
          observationsFed: regimeCounters.observationsFed,
          signalsPassed: regimeCounters.signalsPassed,
          signalsFiltered: regimeCounters.signalsFiltered,
          deniedByStrategy: Object.freeze(
            Object.fromEntries(deniedByStrategy),
          ),
          passedByRegime: Object.freeze({ ...passedByRegime }),
          deniedByRegime: Object.freeze({ ...deniedByRegime }),
        });
  if (regimeActor !== null && regimeActor.getSnapshot().status !== "done") {
    regimeActor.send({ type: "STOP_REQUESTED", reason: "SESSION_END" });
  }
  const metrics = calculateMetrics(
    equityCurve,
    trades,
    config.initialCapital,
    portfolio.positionQuantity,
  );
  return ok(
    Object.freeze({
      runId: config.runId,
      trades: Object.freeze(trades),
      equityCurve: Object.freeze(equityCurve),
      metrics,
      finalPortfolio: Object.freeze({ ...portfolio }),
      processedCandles: validated.value.length,
      protectiveExits: Object.freeze(protectiveExits),
      diagnostics: diagnostics.value,
      diagnosticSamples:
        diagnosticSamples === null ? null : diagnosticSamples.value,
      regimeGating,
    }),
  );
};
