export { createBreakoutStrategy } from "./breakout.js";
export type { BreakoutConfig } from "./breakout.js";
export { createEmaBandTrendStrategy } from "./ema-band-trend.js";
export type { EmaBandTrendConfig } from "./ema-band-trend.js";
export { createEmaCrossStrategy } from "./ema-cross.js";
export { createFundingTrendStrategy, FUNDING_TREND_STRATEGY_ID } from "./funding-trend.js";
export type { FundingTrendConfig } from "./funding-trend.js";
export type { EmaCrossConfig } from "./ema-cross.js";
export { createRsiReversionStrategy } from "./rsi-reversion.js";
export type { RsiReversionConfig } from "./rsi-reversion.js";
export { createStrategyRegistry } from "./strategy.js";
export type {
  Strategy,
  StrategyContext,
  StrategyError,
  StrategyRegistry,
} from "./strategy.js";
export { withConfidenceCalibration } from "./confidence-calibration.js";
export { withTargetSignalNotional } from "./target-notional.js";
