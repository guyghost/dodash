import { describe, expect, it, vi } from "vitest";

import {
  brokerRejectionCodeOf,
  emitTradingTelemetry,
  type TradingTelemetryEvent,
} from "../src/telemetry.js";

const event = (): TradingTelemetryEvent => ({
  schemaVersion: 2,
  type: "cycle.completed",
  timestamp: 100,
  agentId: "grt-usd--multi",
  productId: "GRT-USD",
  executionMode: "live",
  phase: "waiting",
  outcome: "ORDER_CONFIRMED",
  errorCode: null,
  brokerRejectionCode: null,
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
        "NONE",
      ],
      doubles: [100, 25, -10, 990, 5, 0, 1, 0, 1, 1],
    });
  });

  it("projette le code fin des refus broker en blob7 sans surcharger blob6 (dao #47)", () => {
    const sink = { writeDataPoint: vi.fn() };
    const logger = { log: vi.fn(), error: vi.fn() };
    emitTradingTelemetry(
      sink,
      {
        ...event(),
        outcome: "ORDER_REJECTED",
        errorCode: "ORDER_REJECTED",
        brokerRejectionCode: "INSUFFICIENT_CASH",
      },
      logger,
    );

    expect(sink.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: [
          "cycle.completed",
          "GRT-USD",
          "live",
          "waiting",
          "ORDER_REJECTED",
          "ORDER_REJECTED",
          "INSUFFICIENT_CASH",
        ],
      }),
    );
  });

  it("n'extrait le code fin que d'un refus ORDER_REJECTED porteur d'un détail (dao #47)", () => {
    expect(
      brokerRejectionCodeOf({
        phase: "execution",
        code: "ORDER_REJECTED",
        retryable: false,
        detail: "INSUFFICIENT_POSITION",
      }),
    ).toBe("INSUFFICIENT_POSITION");
    expect(
      brokerRejectionCodeOf({
        phase: "execution",
        code: "ORDER_REJECTED",
        retryable: false,
      }),
    ).toBeNull();
    expect(
      brokerRejectionCodeOf({
        phase: "market-data",
        code: "RATE_LIMITED",
        retryable: true,
      }),
    ).toBeNull();
    expect(brokerRejectionCodeOf(null)).toBeNull();
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
