export type TradingTelemetryEventType =
  | "cycle.completed"
  | "control.completed"
  | "preflight.completed";

export interface TradingTelemetryEvent {
  readonly schemaVersion: 1;
  readonly type: TradingTelemetryEventType;
  readonly timestamp: number;
  readonly agentId: string;
  readonly productId: string;
  readonly executionMode: "paper" | "live";
  readonly phase: string;
  readonly outcome: string;
  readonly errorCode: string | null;
  readonly latencyMs: number;
  readonly dailyPnl: number | null;
  readonly accountEquity: number | null;
  readonly positionQuantity: number | null;
  readonly otherExposureNotional: number | null;
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
      blobs: [
        event.type,
        event.productId,
        event.executionMode,
        event.phase,
        event.outcome,
        event.errorCode ?? "NONE",
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
