export {
  MAX_TICKER_DIVERGENCE_BPS,
  TIMEFRAME_MILLISECONDS,
  TIMEFRAMES,
  createCandle,
  createProductId,
  validateCandleSeries,
  validateMarketDataIntegrity,
} from "./market.js";
export type {
  Candle,
  MarketDataIntegrityError,
  MarketValidationError,
  ProductId,
  Timeframe,
} from "./market.js";
export { err, mapResult, ok } from "./result.js";
export type { Result } from "./result.js";
export {
  createClientOrderId,
  createFill,
  createOrderIntent,
  createPosition,
  createSignal,
} from "./trading.js";
export type {
  Fill,
  OrderIntent,
  OrderSide,
  OrderType,
  Position,
  Signal,
  SignalSide,
  TradingValidationError,
} from "./trading.js";

