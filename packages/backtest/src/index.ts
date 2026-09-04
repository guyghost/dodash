export { calculateMetrics } from "./metrics.js";
export type { BacktestMetrics, EquityPoint } from "./metrics.js";
export { withConfidenceCalibration } from "./confidence-calibrated-strategy.js";
export { withTargetSignalNotional } from "./target-notional-strategy.js";
export { loadCoinbaseHistoricalDataset } from "./coinbase-history.js";
export type {
  CoinbaseHistoricalError,
  CoinbaseHistoricalRequest,
  HistoricalDataset,
} from "./coinbase-history.js";
export {
  createBacktestRunId,
  parseBacktestCliOptions,
} from "./cli-options.js";
export type {
  BacktestCliOptions,
  BacktestCliOptionsError,
  BacktestCliProtectiveExitPolicy,
} from "./cli-options.js";
export { runModeledBacktest } from "./modeled-run.js";
export type {
  ModeledBacktestError,
  ModeledBacktestResult,
} from "./modeled-run.js";
export { prepareBacktestIndicators } from "./prepared-indicators.js";
export type {
  PreparedBacktestIndicators,
  PreparedBacktestIndicatorsError,
} from "./prepared-indicators.js";
export { executePaperOrder } from "./paper-broker.js";
export type {
  PaperBrokerConfig,
  PaperBrokerError,
  PaperExecution,
  PaperPortfolio,
  PaperTrade,
} from "./paper-broker.js";
export { replayBacktest } from "./replay.js";
export type {
  BacktestConfig,
  BacktestReplayOptions,
  BacktestReplayError,
  BacktestResult,
  ProtectiveExitExecution,
  RegimeGatingSummary,
} from "./replay.js";
export { replayMultiProductBacktest } from "./multi-product-replay.js";
export type {
  MultiProductBacktestConfig,
  MultiProductBacktestError,
  MultiProductBacktestProductConfig,
  MultiProductBacktestResult,
  MultiProductPosition,
  MultiProductProductResult,
} from "./multi-product-replay.js";
export { runBacktestSuite } from "./suite.js";
export type {
  BacktestScenarioSummary,
  BacktestSuiteConfig,
  BacktestSuiteError,
  BacktestSuiteOptions,
  BacktestSuiteReport,
  BuyHoldBenchmark,
} from "./suite.js";
