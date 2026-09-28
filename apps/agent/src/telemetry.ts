import type { WorkflowError } from "@dodash/models";

export type TradingTelemetryEventType =
  | "cycle.completed"
  | "control.completed"
  | "preflight.completed"
  /** models/trading-telemetry.md, amendement 2026-09-28 : bougie de décision manquée. */
  | "decision.missed";

export interface TradingTelemetryEvent {
  readonly schemaVersion: 3;
  readonly type: TradingTelemetryEventType;
  readonly timestamp: number;
  readonly agentId: string;
  readonly productId: string;
  readonly executionMode: "paper" | "live" | "perp";
  readonly phase: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  /**
   * Code fin du refus broker (dao #47) : vocabulaire fermé de
   * `packages/paper-execution`, uniquement quand `errorCode` vaut
   * `ORDER_REJECTED` ; `null` sinon (et pour control/preflight).
   */
  readonly brokerRejectionCode: string | null;
  readonly latencyMs: number;
  readonly dailyPnl: number | null;
  readonly accountEquity: number | null;
  readonly positionQuantity: number | null;
  readonly otherExposureNotional: number | null;
  readonly valuationQuality: "fresh" | "stale" | "unavailable" | "not_applicable";
  readonly valuationPriceSource: "COINBASE_CANDLE_CLOSE" | "NONE";
  readonly valuationPrice: number | null;
  readonly valuationObservedAt: number | null;
  readonly valuationAgeMs: number | null;
  readonly consolidatedExposureNotional: number | null;
  readonly exposureQuality: "fresh" | "stale" | "unavailable" | "not_applicable";
  readonly executionObserved: boolean;
  readonly openOrderCount: number | null;
}

export interface TradingTelemetrySink {
  writeDataPoint(point: {
    readonly blobs: readonly string[];
    readonly doubles: readonly number[];
    readonly indexes: readonly string[];
  }): void;
}

export interface TradingTelemetryLogger {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Extraction du code fin depuis l'erreur terminale d'un cycle : le détail
 * n'est lu que sur `ORDER_REJECTED` (blob6 reste le code WorkflowError,
 * jamais surchargé).
 */
export const brokerRejectionCodeOf = (
  error: WorkflowError | null | undefined,
): string | null =>
  error !== null && error !== undefined && error.code === "ORDER_REJECTED"
    ? error.detail ?? null
    : null;

const finiteOrZero = (value: number | null): number =>
  value !== null && Number.isFinite(value) ? value : 0;

export const emitTradingTelemetry = (
  sink: TradingTelemetrySink | undefined,
  event: TradingTelemetryEvent,
  logger: TradingTelemetryLogger = console,
): void => {
  logger.log(JSON.stringify(event));
  if (sink === undefined) return;
  try {
    sink.writeDataPoint({
      indexes: [event.agentId],
      // Projection positionnelle Analytics Engine (models/trading-telemetry.md,
      // § Amendement dao #62) : blobs 1–7 restent figés (blob7 code broker).
      // blob8 qualité valuation · blob9 provenance · blob10 qualité exposition.
      blobs: [
        event.type,
        event.productId,
        event.executionMode,
        event.phase,
        event.outcome,
        event.errorCode ?? "NONE",
        event.brokerRejectionCode ?? "NONE",
        event.valuationQuality,
        event.valuationPriceSource,
        event.exposureQuality,
      ],
      doubles: [
        event.timestamp,
        event.latencyMs,
        finiteOrZero(event.dailyPnl),
        finiteOrZero(event.accountEquity),
        finiteOrZero(event.positionQuantity),
        finiteOrZero(event.otherExposureNotional),
        event.executionObserved ? 1 : 0,
        finiteOrZero(event.openOrderCount),
        event.dailyPnl === null ? 0 : 1,
        event.accountEquity === null ? 0 : 1,
        finiteOrZero(event.valuationPrice),
        finiteOrZero(event.valuationObservedAt),
        finiteOrZero(event.valuationAgeMs),
        finiteOrZero(event.consolidatedExposureNotional),
        event.valuationPrice === null ? 0 : 1,
        event.valuationObservedAt === null ? 0 : 1,
        event.valuationAgeMs === null ? 0 : 1,
        event.consolidatedExposureNotional === null ? 0 : 1,
      ],
    });
  } catch {
    logger.error(
      JSON.stringify({
        schemaVersion: 1,
        type: "telemetry.write_failed",
        timestamp: event.timestamp,
        agentId: event.agentId,
        productId: event.productId,
      }),
    );
  }
};
