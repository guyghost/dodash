import { createOrderIntent, err, ok, type Result } from "@dodash/domain";
import type { IndicatorConfig } from "@dodash/indicators-prolog";
import type { ProtectiveExitPolicy } from "@dodash/models";
import type { RiskConfig } from "@dodash/risk";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

import type { HistoricalDataset } from "./coinbase-history.js";
import type { BacktestMetrics } from "./metrics.js";
import {
  executePaperOrder,
  type PaperBrokerConfig,
  type PaperPortfolio,
} from "./paper-broker.js";
import { prepareBacktestIndicators } from "./prepared-indicators.js";
import { replayBacktest } from "./replay.js";

export interface BacktestSuiteConfig {
  readonly runId: string;
  readonly agentId: string;
  readonly initialCapital: number;
  readonly maxDecisionNotional: number;
  readonly minNetQuantity: number;
  readonly baseSize: number;
  readonly indicators: IndicatorConfig;
  readonly risk: RiskConfig;
  readonly broker: PaperBrokerConfig;
  readonly protectiveExit?: ProtectiveExitPolicy;
}

export interface BacktestSuiteOptions {
  readonly executionDataset?: HistoricalDataset;
}

export interface BuyHoldBenchmark {
  readonly pnl: number;
  readonly totalReturn: number;
  readonly finalEquity: number;
}

export interface BacktestScenarioSummary {
  readonly id: "rsi-reversion" | "ema-cross" | "breakout" | "ensemble";
  readonly strategyIds: readonly string[];
  readonly tradeCount: number;
  readonly metrics: BacktestMetrics;
  readonly finalPortfolio: PaperPortfolio;
  readonly excessReturn: number;
  readonly protectiveExitCount: number;
}

export interface BacktestSuiteReport {
  readonly runId: string;
  readonly dataset: Omit<HistoricalDataset, "candles"> & { readonly candleCount: number };
  readonly executionDataset:
    | (Omit<HistoricalDataset, "candles"> & { readonly candleCount: number })
    | null;
  readonly config: BacktestSuiteConfig;
  readonly benchmark: BuyHoldBenchmark;
  readonly scenarios: readonly BacktestScenarioSummary[];
}

export type BacktestSuiteError =
  | { readonly code: "INVALID_SUITE_CONFIG" }
  | { readonly code: "INVALID_EXECUTION_DATASET" }
  | { readonly code: "INVALID_STRATEGY_REGISTRY" }
  | { readonly code: "INDICATOR_PREPARATION_FAILED"; readonly cause: unknown }
  | {
      readonly code: "SCENARIO_REPLAY_FAILED";
      readonly scenarioId: BacktestScenarioSummary["id"];
      readonly cause: unknown;
    };

const validConfig = (config: BacktestSuiteConfig): boolean =>
  config.runId.trim().length > 0 &&
  config.agentId.trim().length > 0 &&
  Number.isFinite(config.initialCapital) &&
  config.initialCapital > 0 &&
  Number.isFinite(config.maxDecisionNotional) &&
  config.maxDecisionNotional > 0 &&
  Number.isFinite(config.minNetQuantity) &&
  config.minNetQuantity >= 0 &&
  Number.isFinite(config.baseSize) &&
  config.baseSize > 0;

const compatibleExecutionDataset = (
  primary: HistoricalDataset,
  execution: HistoricalDataset,
): boolean =>
  execution.productId === primary.productId &&
  execution.startAt === primary.startAt &&
  execution.endAt === primary.endAt &&
  execution.datasetId.trim().length > 0 &&
  execution.sha256.trim().length > 0 &&
  execution.candles.length > 0;

const datasetMetadata = (
  dataset: HistoricalDataset,
): Omit<HistoricalDataset, "candles"> & { readonly candleCount: number } => {
  const { candles, ...metadata } = dataset;
  return Object.freeze({ ...metadata, candleCount: candles.length });
};

const strategiesById = (
  config: BacktestSuiteConfig,
): Readonly<Record<string, Strategy>> =>
  Object.freeze({
    "rsi-reversion": createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: config.baseSize,
    }),
    "ema-cross": createEmaCrossStrategy({ baseSize: config.baseSize }),
    breakout: createBreakoutStrategy({ lookback: 20, baseSize: config.baseSize }),
  });

const benchmarkBuyAndHold = (
  dataset: HistoricalDataset,
  config: BacktestSuiteConfig,
): BuyHoldBenchmark | null => {
  const first = dataset.candles[0];
  const last = dataset.candles.at(-1);
  if (first === undefined || last === undefined) return null;
  const executionPrice = first.open * (1 + config.broker.slippageBps / 10_000);
  const feeRate = config.broker.feeBps / 10_000;
  const quantity = config.initialCapital / (executionPrice * (1 + feeRate));
  const intent = createOrderIntent({
    clientOrderId: `${config.runId}-buy-hold`,
    decisionId: `${config.runId}-buy-hold`,
    strategyIds: ["buy-and-hold"],
    productId: dataset.productId,
    side: "BUY",
    type: "MARKET",
    quantity,
    limitPrice: null,
  });
  if (!intent.ok) return null;
  const execution = executePaperOrder(
    { cash: config.initialCapital, positionQuantity: 0, averagePrice: 0 },
    intent.value,
    first.open,
    first.start,
    config.broker,
  );
  if (!execution.ok) return null;
  const finalEquity =
    execution.value.portfolio.cash +
    execution.value.portfolio.positionQuantity * last.close;
  const pnl = finalEquity - config.initialCapital;
  return Object.freeze({
    pnl,
    totalReturn: pnl / config.initialCapital,
    finalEquity,
  });
};

export const runBacktestSuite = async (
  dataset: HistoricalDataset,
  config: BacktestSuiteConfig,
  options?: BacktestSuiteOptions,
): Promise<Result<BacktestSuiteReport, BacktestSuiteError>> => {
  if (!validConfig(config) || dataset.candles.length === 0) {
    return err({ code: "INVALID_SUITE_CONFIG" });
  }
  if (
    options?.executionDataset !== undefined &&
    !compatibleExecutionDataset(dataset, options.executionDataset)
  ) {
    return err({ code: "INVALID_EXECUTION_DATASET" });
  }
  const benchmark = benchmarkBuyAndHold(dataset, config);
  if (benchmark === null) return err({ code: "INVALID_SUITE_CONFIG" });
  const preparedIndicators = await prepareBacktestIndicators(
    dataset.candles,
    config.indicators,
  );
  if (!preparedIndicators.ok) {
    return err({
      code: "INDICATOR_PREPARATION_FAILED",
      cause: preparedIndicators.error,
    });
  }

  const strategies = strategiesById(config);
  const definitions = [
    { id: "rsi-reversion", strategyIds: ["rsi-reversion"] },
    { id: "ema-cross", strategyIds: ["ema-cross"] },
    { id: "breakout", strategyIds: ["breakout"] },
    {
      id: "ensemble",
      strategyIds: ["rsi-reversion", "ema-cross", "breakout"],
    },
  ] as const;
  const scenarios: BacktestScenarioSummary[] = [];

  for (const definition of definitions) {
    const selected = definition.strategyIds.map((id) => strategies[id]);
    if (selected.some((strategy) => strategy === undefined)) {
      return err({ code: "INVALID_STRATEGY_REGISTRY" });
    }
    const registry = createStrategyRegistry(selected as readonly Strategy[]);
    if (!registry.ok) return err({ code: "INVALID_STRATEGY_REGISTRY" });
    const replay = await replayBacktest(
      dataset.candles,
      {
        runId: `${config.runId}:${definition.id}`,
        agentId: config.agentId,
        productId: dataset.productId,
        initialCapital: config.initialCapital,
        maxDecisionNotional: config.maxDecisionNotional,
        minNetQuantity: config.minNetQuantity,
        indicators: config.indicators,
        strategies: registry.value,
        risk: config.risk,
        broker: config.broker,
        ...(config.protectiveExit === undefined
          ? {}
          : { protectiveExit: config.protectiveExit }),
      },
      preparedIndicators.value,
      options?.executionDataset === undefined
        ? undefined
        : { executionCandles: options.executionDataset.candles },
    );
    if (!replay.ok) {
      return err({
        code: "SCENARIO_REPLAY_FAILED",
        scenarioId: definition.id,
        cause: replay.error,
      });
    }
    scenarios.push(
      Object.freeze({
        id: definition.id,
        strategyIds: Object.freeze([...definition.strategyIds]),
        tradeCount: replay.value.trades.length,
        metrics: replay.value.metrics,
        finalPortfolio: replay.value.finalPortfolio,
        excessReturn: replay.value.metrics.totalReturn - benchmark.totalReturn,
        protectiveExitCount: replay.value.protectiveExits.length,
      }),
    );
  }

  return ok(
    Object.freeze({
      runId: config.runId,
      dataset: datasetMetadata(dataset),
      executionDataset:
        options?.executionDataset === undefined
          ? null
          : datasetMetadata(options.executionDataset),
      config: Object.freeze({ ...config }),
      benchmark,
      scenarios: Object.freeze(scenarios),
    }),
  );
};
