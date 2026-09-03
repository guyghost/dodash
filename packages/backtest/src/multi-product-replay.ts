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
  requiredIndicatorCandles,
  type IndicatorConfig,
  type IndicatorError,
  type IndicatorSnapshot,
} from "@dodash/indicators-prolog";
import {
  resolveDailyRiskWindow,
  resolveRiskEvaluationTimestamp,
  resolveSpotPermission,
  type DailyRiskWindow,
  type SpotPermissionError,
} from "@dodash/models";
import {
  evaluatePortfolioRisk,
  type PortfolioProductRiskInput,
  type PortfolioRiskError,
  type PortfolioRiskLimits,
  type RiskConfig,
} from "@dodash/risk";
import type { StrategyError, StrategyRegistry } from "@dodash/strategies";

import { calculateMetrics, type BacktestMetrics, type EquityPoint } from "./metrics.js";
import { capSpotOrder } from "./replay.js";
import {
  executePaperOrder,
  type PaperBrokerConfig,
  type PaperBrokerError,
  type PaperPortfolio,
  type PaperTrade,
} from "./paper-broker.js";

/**
 * Backtest multi-produits (models/multi-product-portfolio.md §8) : rejoue
 * le MÊME cœur métier que `replayBacktest` (indicateurs → stratégies →
 * allocation → risque par produit + consolidé → courtier paper) sur des
 * séries de bougies alignées, sans I/O ni horloge globale (C3).
 *
 * Hors périmètre (INV-P8) : sorties protectrices et filtre de régime —
 * absents de la configuration, donc impossibles à simuler par accident.
 */

export interface MultiProductBacktestProductConfig {
  readonly productId: ProductId;
  readonly candles: readonly Candle[];
  readonly strategies: StrategyRegistry;
  readonly indicators: IndicatorConfig;
  readonly risk: RiskConfig;
}

export interface MultiProductBacktestConfig {
  readonly runId: string;
  readonly agentId: string;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly broker: PaperBrokerConfig;
  readonly portfolioRisk: PortfolioRiskLimits;
  readonly products: readonly MultiProductBacktestProductConfig[];
}

export interface MultiProductPosition {
  readonly quantity: number;
  readonly averagePrice: number;
}

export interface MultiProductProductResult {
  readonly productId: ProductId;
  readonly trades: readonly PaperTrade[];
  readonly realizedPnl: number;
  readonly finalPosition: MultiProductPosition;
}

export interface MultiProductBacktestResult {
  readonly runId: string;
  readonly trades: readonly PaperTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
  readonly finalPortfolio: {
    readonly cash: number;
    readonly positions: Readonly<Record<string, MultiProductPosition>>;
  };
  readonly processedCandles: number;
  readonly perProduct: readonly MultiProductProductResult[];
}

export type MultiProductBacktestError =
  | { readonly code: "INVALID_MULTI_PRODUCT_CONFIG" }
  | {
      readonly code: "INVALID_CANDLES";
      readonly productId: string;
      readonly cause: MarketValidationError;
    }
  | { readonly code: "MISALIGNED_PRODUCT_CANDLES" }
  | { readonly code: "INDICATOR_FAILURE"; readonly cause: IndicatorError }
  | { readonly code: "STRATEGY_FAILURE"; readonly cause: StrategyError }
  | { readonly code: "ALLOCATION_FAILURE"; readonly cause: AllocationError }
  | { readonly code: "RISK_FAILURE"; readonly cause: PortfolioRiskError }
  | {
      readonly code: "SPOT_PERMISSION_FAILURE";
      readonly productId: string;
      readonly cause: SpotPermissionError;
    }
  | { readonly code: "BROKER_FAILURE"; readonly cause: PaperBrokerError };

const validLimits = (limits: PortfolioRiskLimits): boolean =>
  Number.isFinite(limits.maxGrossExposure) &&
  limits.maxGrossExposure > 0 &&
  Number.isFinite(limits.maxDailyLoss) &&
  limits.maxDailyLoss > 0;

const validConfig = (config: MultiProductBacktestConfig): boolean =>
  config.runId.trim().length > 0 &&
  config.agentId.trim().length > 0 &&
  Number.isFinite(config.initialCapital) &&
  config.initialCapital > 0 &&
  Number.isFinite(config.maxDecisionNotional) &&
  config.maxDecisionNotional > 0 &&
  Number.isFinite(config.minNetQuantity) &&
  config.minNetQuantity >= 0 &&
  validLimits(config.portfolioRisk) &&
  config.products.length > 0;

const byProductId = (
  left: { readonly productId: string },
  right: { readonly productId: string },
): number =>
  left.productId < right.productId
    ? -1
    : left.productId > right.productId
      ? 1
      : 0;

export const replayMultiProductBacktest = async (
  config: MultiProductBacktestConfig,
): Promise<Result<MultiProductBacktestResult, MultiProductBacktestError>> => {
  if (!validConfig(config)) return err({ code: "INVALID_MULTI_PRODUCT_CONFIG" });

  // INV-P4 : traitement déterministe dans l'ordre trié des identifiants.
  const products = [...config.products].sort(byProductId);
  for (let index = 1; index < products.length; index += 1) {
    const previous = products[index - 1];
    const current = products[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.productId === current.productId
    ) {
      return err({ code: "INVALID_MULTI_PRODUCT_CONFIG" });
    }
  }

  const validatedSeries: Candle[][] = [];
  for (const product of products) {
    const validated = validateCandleSeries(product.candles);
    if (!validated.ok) {
      return err({
        code: "INVALID_CANDLES",
        productId: product.productId,
        cause: validated.error,
      });
    }
    validatedSeries.push([...validated.value]);
  }
  const candleCount = validatedSeries[0]?.length ?? 0;
  for (let index = 0; index < products.length; index += 1) {
    const series = validatedSeries[index];
    const reference = validatedSeries[0];
    if (
      series === undefined ||
      reference === undefined ||
      series.length !== reference.length ||
      series.some((candle, candleIndex) => {
        const aligned = reference[candleIndex];
        return aligned === undefined || candle.start !== aligned.start;
      })
    ) {
      return err({ code: "MISALIGNED_PRODUCT_CANDLES" });
    }
  }
  if (candleCount === 0) return err({ code: "MISALIGNED_PRODUCT_CANDLES" });

  const positions = new Map<string, MultiProductPosition>(
    products.map((product) => [product.productId, { quantity: 0, averagePrice: 0 }]),
  );
  const realized = new Map<string, number>(
    products.map((product) => [product.productId, 0]),
  );
  const trades: PaperTrade[] = [];
  const productTrades = new Map<string, PaperTrade[]>(
    products.map((product) => [product.productId, []]),
  );
  const lastTradeAt = new Map<string, number | null>(
    products.map((product) => [product.productId, null]),
  );
  const previousIndicators = new Map<string, IndicatorSnapshot | null>(
    products.map((product) => [product.productId, null]),
  );
  const dailyWindows = new Map<string, DailyRiskWindow | null>(
    products.map((product) => [product.productId, null]),
  );
  let consolidatedWindow: DailyRiskWindow | null = null;
  let cash = config.initialCapital;
  let pendingOrders: readonly { readonly productId: string; readonly order: OrderIntent }[] = [];
  const equityCurve: EquityPoint[] = [];

  const warmupMax = Math.max(
    ...products.map((product) => requiredIndicatorCandles(product.indicators)),
  );
  const closeAt = (productIndex: number, candleIndex: number): number => {
    const candle = validatedSeries[productIndex]?.[candleIndex];
    if (candle === undefined) throw new Error("unreachable: aligned series");
    return candle.close;
  };
  const equityAt = (candleIndex: number): number => {
    let equity = cash;
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      const position = positions.get(product?.productId ?? "");
      if (product === undefined || position === undefined) continue;
      equity += position.quantity * closeAt(index, candleIndex);
    }
    return equity;
  };
  const productPnlProxy = (
    productId: string,
    productIndex: number,
    candleIndex: number,
  ): number => {
    const position = positions.get(productId) ?? { quantity: 0, averagePrice: 0 };
    const close = closeAt(productIndex, candleIndex);
    const unrealized =
      position.quantity === 0 ? 0 : position.quantity * (close - position.averagePrice);
    return (realized.get(productId) ?? 0) + unrealized;
  };

  for (let index = 0; index < candleCount; index += 1) {
    // 1. Exécution des ordres en attente à l'ouverture (même sémantique
    // que le replay mono-produit : décision au close t−1, exécution à
    // l'open t), trésorerie partagée, positions par produit.
    for (const pending of pendingOrders) {
      const productIndex = products.findIndex(
        (product) => product.productId === pending.productId,
      );
      const product = products[productIndex];
      if (product === undefined || productIndex < 0) {
        return err({ code: "INVALID_MULTI_PRODUCT_CONFIG" });
      }
      const executionCandle = validatedSeries[productIndex]?.[index];
      if (executionCandle === undefined) {
        return err({ code: "MISALIGNED_PRODUCT_CANDLES" });
      }
      const positionBefore = positions.get(pending.productId) ?? {
        quantity: 0,
        averagePrice: 0,
      };
      const permission = resolveSpotPermission(
        pending.order.side,
        pending.order.quantity,
        positionBefore.quantity,
      );
      if (!permission.ok) {
        return err({
          code: "SPOT_PERMISSION_FAILURE",
          productId: pending.productId,
          cause: permission.error,
        });
      }
      if (permission.value.status === "INEXECUTABLE") continue;
      const virtualPortfolio: PaperPortfolio = {
        cash,
        positionQuantity: positionBefore.quantity,
        averagePrice: positionBefore.averagePrice,
      };
      const capped = capSpotOrder(
        pending.order,
        virtualPortfolio,
        executionCandle.open,
        config.broker,
        config.minNetQuantity,
      );
      if (capped === null) continue;
      const execution = executePaperOrder(
        virtualPortfolio,
        capped,
        executionCandle.open,
        executionCandle.start,
        config.broker,
      );
      if (!execution.ok) return err({ code: "BROKER_FAILURE", cause: execution.error });
      cash = execution.value.portfolio.cash;
      positions.set(pending.productId, {
        quantity: execution.value.portfolio.positionQuantity,
        averagePrice: execution.value.portfolio.averagePrice,
      });
      realized.set(
        pending.productId,
        (realized.get(pending.productId) ?? 0) + execution.value.trade.realizedPnl,
      );
      trades.push(execution.value.trade);
      productTrades.get(pending.productId)?.push(execution.value.trade);
      lastTradeAt.set(pending.productId, executionCandle.start);
    }
    pendingOrders = [];

    if (index < warmupMax - 1) {
      equityCurve.push(
        Object.freeze({ at: validatedSeries[0]?.[index]?.start ?? 0, equity: equityAt(index) }),
      );
      continue;
    }

    // 2. Indicateurs et stratégies par produit, signaux mis en commun.
    const pooledSignals = [];
    const alignedStart = validatedSeries[0]?.[index]?.start ?? 0;
    for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
      const product = products[productIndex];
      const series = validatedSeries[productIndex];
      if (product === undefined || series === undefined) {
        return err({ code: "INVALID_MULTI_PRODUCT_CONFIG" });
      }
      const history = series.slice(0, index + 1);
      const indicatorResult = await computeIndicators(history, product.indicators);
      if (!indicatorResult.ok) {
        return err({ code: "INDICATOR_FAILURE", cause: indicatorResult.error });
      }
      const signalResult = product.strategies.evaluateAll({
        productId: product.productId,
        candles: history,
        indicators: indicatorResult.value,
        previousIndicators: previousIndicators.get(product.productId) ?? null,
      });
      if (!signalResult.ok) {
        return err({ code: "STRATEGY_FAILURE", cause: signalResult.error });
      }
      pooledSignals.push(...signalResult.value);
      previousIndicators.set(product.productId, indicatorResult.value);
    }

    const allocation = allocateSignals({
      agentId: config.agentId,
      cycleId: `${config.runId}:${alignedStart}`,
      decisionId: `${config.runId}:decision:${alignedStart}`,
      signals: pooledSignals,
      marketPrices: Object.fromEntries(
        products.map((product, productIndex) => [
          product.productId,
          closeAt(productIndex, index),
        ]),
      ),
      capitalAvailable: Math.max(0, cash),
      maxDecisionNotional: config.maxDecisionNotional,
      minNetQuantity: config.minNetQuantity,
    });
    if (!allocation.ok) {
      return err({ code: "ALLOCATION_FAILURE", cause: allocation.error });
    }

    // 3. Risque par produit (checkRisk via evaluatePortfolioRisk) puis
    // plafonds consolidés (INV-P1, INV-P2) — une seule évaluation pure.
    const riskInputs: PortfolioProductRiskInput[] = [];
    const orderFor = new Map<string, OrderIntent>();
    for (const order of allocation.value.orders) {
      orderFor.set(order.productId, order);
    }
    for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
      const product = products[productIndex];
      if (product === undefined) continue;
      const position = positions.get(product.productId) ?? {
        quantity: 0,
        averagePrice: 0,
      };
      const close = closeAt(productIndex, index);
      // Fenêtre quotidienne produit (INV-P8, miroir de
      // models/daily-pnl-fidelity.md INV-P1) : marquée sur le PnL
      // realized + latent du produit, roulée à chaque bougie évaluée.
      const dailyRisk = resolveDailyRiskWindow(
        dailyWindows.get(product.productId) ?? null,
        alignedStart,
        productPnlProxy(product.productId, productIndex, index),
      );
      dailyWindows.set(product.productId, dailyRisk.window);
      riskInputs.push({
        productId: product.productId,
        intent: orderFor.get(product.productId) ?? null,
        snapshot: {
          marketPrice: close,
          currentPositionQuantity: position.quantity,
          otherExposureNotional: 0,
          dailyPnl: dailyRisk.dailyPnl,
          lastTradeAt: lastTradeAt.get(product.productId) ?? null,
          now: resolveRiskEvaluationTimestamp(
            alignedStart,
            lastTradeAt.get(product.productId) ?? null,
          ),
          killSwitchActive: false,
        },
        config: product.risk,
      });
    }
    const evaluation = evaluatePortfolioRisk(riskInputs, config.portfolioRisk);
    if (!evaluation.ok) {
      return err({ code: "RISK_FAILURE", cause: evaluation.error });
    }

    // 4. Ordres approuvés mis en attente pour l'ouverture suivante.
    const approved: { readonly productId: string; readonly order: OrderIntent }[] = [];
    for (const outcome of evaluation.value.decisions) {
      if (outcome.decision.status !== "APPROVED") continue;
      const order = orderFor.get(outcome.productId);
      if (order === undefined) continue;
      approved.push({ productId: outcome.productId, order });
    }
    pendingOrders = Object.freeze(approved);

    // 5. Perte quotidienne consolidée : marquée sur l'équité totale
    // (trésorerie + Σ positions valorisées), même fenêtre UTC que le live.
    const consolidatedRisk = resolveDailyRiskWindow(
      consolidatedWindow,
      alignedStart,
      equityAt(index),
    );
    consolidatedWindow = consolidatedRisk.window;

    equityCurve.push(Object.freeze({ at: alignedStart, equity: equityAt(index) }));
  }

  const finalPositions: Record<string, MultiProductPosition> = {};
  const perProduct: MultiProductProductResult[] = products.map((product) => {
    const position = positions.get(product.productId) ?? {
      quantity: 0,
      averagePrice: 0,
    };
    finalPositions[product.productId] = position;
    return Object.freeze({
      productId: product.productId,
      trades: Object.freeze(productTrades.get(product.productId) ?? []),
      realizedPnl: realized.get(product.productId) ?? 0,
      finalPosition: Object.freeze(position),
    });
  });

  const openQuantity = [...positions.values()].reduce(
    (total, position) => total + position.quantity,
    0,
  );
  const metrics = calculateMetrics(equityCurve, trades, config.initialCapital, openQuantity);
  return ok(
    Object.freeze({
      runId: config.runId,
      trades: Object.freeze(trades),
      equityCurve: Object.freeze(equityCurve),
      metrics,
      finalPortfolio: Object.freeze({
        cash,
        positions: Object.freeze(finalPositions),
      }),
      processedCandles: candleCount,
      perProduct: Object.freeze(perProduct),
    }),
  );
};
