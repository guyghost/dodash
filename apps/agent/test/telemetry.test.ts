import { describe, expect, it, vi } from "vitest";

import {
  emitTradingTelemetry,
  type TradingTelemetryEvent,
} from "../src/telemetry.js";

const event = (): TradingTelemetryEvent => ({
  schemaVersion: 1,
  type: "cycle.completed",
  timestamp: 100,
  agentId: "grt-usd--multi",
  productId: "GRT-USD",
  executionMode: "live",
  phase: "waiting",
  outcome: "ORDER_CONFIRMED",
  errorCode: null,
  latencyMs: 25,
  dailyPnl: -10,
  accountEquity: 990,
  positionQuantity: 5,
  otherExposureNotional: 0,
  executionObserved: true,
  openOrderCount: null,
});

describe("trading telemetry", () => {
  it("writes one structured log and one fixed Analytics Engine point", () => {
    const sink = { writeDataPoint: vi.fn() };
    const logger = { log: vi.fn(), error: vi.fn() };
    emitTradingTelemetry(sink, event(), logger);

    expect(logger.log).toHaveBeenCalledOnce();
    expect(JSON.parse(logger.log.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      type: "cycle.completed",
      outcome: "ORDER_CONFIRMED",
    });
    expect(sink.writeDataPoint).toHaveBeenCalledWith({
      indexes: ["grt-usd--multi"],
      blobs: [
        "cycle.completed",
        "GRT-USD",
        "live",
        "waiting",
        "ORDER_CONFIRMED",
        "NONE",
      ],
      doubles: [100, 25, -10, 990, 5, 0, 1, 0, 1, 1],
    });
  });

  it("logs sink failure without throwing into the trading workflow", () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    expect(() =>
      emitTradingTelemetry(
        {
          writeDataPoint: () => {
            throw new Error("sink unavailable");
          },
        },
        event(),
        logger,
      ),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
