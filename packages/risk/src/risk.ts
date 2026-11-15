import { err, ok, type OrderIntent, type Result } from "@dodash/domain";

export interface RiskConfig {
  readonly maxOrderNotional: number;
  readonly maxPositionNotional: number;
  readonly maxGrossExposure: number;
  readonly maxDailyLoss: number;
  readonly cooldownMs: number;
  readonly stopLossBps: number;
  readonly takeProfitBps: number;
  readonly atrStopLossMultiple?: number;
  readonly atrTakeProfitMultiple?: number;
}

export interface RiskSnapshot {
  readonly marketPrice: number;
  readonly currentPositionQuantity: number;
  readonly otherExposureNotional: number;
  readonly dailyPnl: number;
  readonly lastTradeAt: number | null;
  readonly now: number;
  readonly killSwitchActive: boolean;
  readonly atr?: number;
}

export type RiskReasonCode =
  | "KILL_SWITCH_ACTIVE"
  | "DAILY_LOSS_LIMIT"
  | "COOLDOWN_ACTIVE"
  | "SPOT_SHORT_FORBIDDEN"
  | "ORDER_NOTIONAL_LIMIT"
  | "POSITION_NOTIONAL_LIMIT"
  | "GROSS_EXPOSURE_LIMIT";

export type RiskDecision =
  | {
      readonly status: "APPROVED";
      readonly stopLossPrice: number;
      readonly takeProfitPrice: number;
      readonly projectedPositionNotional: number;
      readonly projectedGrossExposure: number;
    }
  | { readonly status: "REJECTED"; readonly reasonCode: RiskReasonCode };

export type RiskError =
  | { readonly code: "INVALID_RISK_CONFIG" }
  | { readonly code: "INVALID_RISK_SNAPSHOT" };

const MAX_ATR_STOP_DISTANCE = 0.9999;
const MAX_ATR_TAKE_DISTANCE = 9.9999;

const validPositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const validOptionalPositive = (value: number | undefined): boolean =>
  value === undefined || validPositive(value);

const validConfig = (config: RiskConfig): boolean =>
  validPositive(config.maxOrderNotional) &&
  validPositive(config.maxPositionNotional) &&
  validPositive(config.maxGrossExposure) &&
  validPositive(config.maxDailyLoss) &&
  Number.isSafeInteger(config.cooldownMs) &&
  config.cooldownMs >= 0 &&
  validPositive(config.stopLossBps) &&
  validPositive(config.takeProfitBps) &&
  config.stopLossBps < 10_000 &&
  config.takeProfitBps < 100_000 &&
  validOptionalPositive(config.atrStopLossMultiple) &&
  validOptionalPositive(config.atrTakeProfitMultiple);

const validSnapshot = (snapshot: RiskSnapshot): boolean =>
  validPositive(snapshot.marketPrice) &&
  Number.isFinite(snapshot.currentPositionQuantity) &&
  Number.isFinite(snapshot.otherExposureNotional) &&
  snapshot.otherExposureNotional >= 0 &&
  Number.isFinite(snapshot.dailyPnl) &&
  Number.isSafeInteger(snapshot.now) &&
  snapshot.now >= 0 &&
  (snapshot.lastTradeAt === null ||
    (Number.isSafeInteger(snapshot.lastTradeAt) &&
      snapshot.lastTradeAt >= 0 &&
      snapshot.lastTradeAt <= snapshot.now)) &&
  validOptionalPositive(snapshot.atr);

const resolveProtectionDistances = (
  snapshot: RiskSnapshot,
  config: RiskConfig,
): { readonly stopDistance: number; readonly takeDistance: number } => {
  if (
    snapshot.atr !== undefined &&
    config.atrStopLossMultiple !== undefined &&
    config.atrTakeProfitMultiple !== undefined
  ) {
    return {
      stopDistance: Math.min(
        (snapshot.atr * config.atrStopLossMultiple) / snapshot.marketPrice,
        MAX_ATR_STOP_DISTANCE,
      ),
      takeDistance: Math.min(
        (snapshot.atr * config.atrTakeProfitMultiple) / snapshot.marketPrice,
        MAX_ATR_TAKE_DISTANCE,
      ),
    };
  }
  return {
    stopDistance: config.stopLossBps / 10_000,
    takeDistance: config.takeProfitBps / 10_000,
  };
};

export const checkRisk = (
  intent: OrderIntent,
  snapshot: RiskSnapshot,
  config: RiskConfig,
): Result<RiskDecision, RiskError> => {
  if (!validConfig(config)) return err({ code: "INVALID_RISK_CONFIG" });
  if (!validSnapshot(snapshot)) return err({ code: "INVALID_RISK_SNAPSHOT" });

  if (snapshot.killSwitchActive) {
    return ok({ status: "REJECTED", reasonCode: "KILL_SWITCH_ACTIVE" });
  }
  if (snapshot.dailyPnl <= -config.maxDailyLoss) {
    return ok({ status: "REJECTED", reasonCode: "DAILY_LOSS_LIMIT" });
  }
  if (
    snapshot.lastTradeAt !== null &&
    snapshot.now - snapshot.lastTradeAt < config.cooldownMs
  ) {
    return ok({ status: "REJECTED", reasonCode: "COOLDOWN_ACTIVE" });
  }

  const orderNotional = intent.quantity * snapshot.marketPrice;
  if (orderNotional > config.maxOrderNotional) {
    return ok({ status: "REJECTED", reasonCode: "ORDER_NOTIONAL_LIMIT" });
  }

  const signedQuantity = intent.side === "BUY" ? intent.quantity : -intent.quantity;
  const projectedPositionQuantity =
    snapshot.currentPositionQuantity + signedQuantity;
  if (projectedPositionQuantity < -1e-12) {
    return ok({ status: "REJECTED", reasonCode: "SPOT_SHORT_FORBIDDEN" });
  }
  const projectedPositionNotional =
    Math.abs(projectedPositionQuantity) * snapshot.marketPrice;
  if (projectedPositionNotional > config.maxPositionNotional) {
    return ok({ status: "REJECTED", reasonCode: "POSITION_NOTIONAL_LIMIT" });
  }

  const projectedGrossExposure =
    snapshot.otherExposureNotional + projectedPositionNotional;
  if (projectedGrossExposure > config.maxGrossExposure) {
    return ok({ status: "REJECTED", reasonCode: "GROSS_EXPOSURE_LIMIT" });
  }

  const { stopDistance, takeDistance } = resolveProtectionDistances(
    snapshot,
    config,
  );
  const stopLossPrice =
    intent.side === "BUY"
      ? snapshot.marketPrice * (1 - stopDistance)
      : snapshot.marketPrice * (1 + stopDistance);
  const takeProfitPrice =
    intent.side === "BUY"
      ? snapshot.marketPrice * (1 + takeDistance)
      : snapshot.marketPrice * (1 - takeDistance);

  return ok(
    Object.freeze({
      status: "APPROVED" as const,
      stopLossPrice,
      takeProfitPrice,
      projectedPositionNotional,
      projectedGrossExposure,
    }),
  );
};
