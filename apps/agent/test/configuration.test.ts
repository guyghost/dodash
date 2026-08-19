import { describe, expect, it } from "vitest";

import { parseAgentConfiguration } from "../src/configuration.js";

describe("parseAgentConfiguration", () => {
  it("normalizes a valid paper configuration", () => {
    const result = parseAgentConfiguration({
      productId: "btc-usd",
      strategyIds: ["rsi-reversion", "rsi-reversion"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.productId).toBe("BTC-USD");
    expect(result.value.strategyIds).toEqual(["rsi-reversion"]);
    expect(result.value.executionMode).toBe("paper");
  });

  it("rejects a candle limit below the configured warmup", () => {
    const result = parseAgentConfiguration({
      productId: "BTC-USD",
      candleLimit: 5,
      strategyIds: ["breakout"],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CANDLE_LIMIT" },
    });
  });

  it("inclut la force de tendance dans le warmup minimal", () => {
    const result = parseAgentConfiguration({
      productId: "BTC-USD",
      candleLimit: 19,
      strategyIds: ["rsi-reversion"],
      indicators: {
        rsiPeriod: 2,
        emaFastPeriod: 1,
        emaSlowPeriod: 2,
        atrPeriod: 2,
        historicalVolatilityPeriod: 2,
        momentumPeriod: 1,
        returnPeriods: [1],
        vwapPeriod: 2,
        relativeVolumePeriod: 1,
        volumeSpikeThreshold: 2,
        volumeTrendPeriod: 2,
        trendStrengthPeriod: 10,
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "INSUFFICIENT_CANDLE_LIMIT" },
    });
  });

  it("models live execution without accepting credentials in the configuration", () => {
    const result = parseAgentConfiguration({
      productId: "BTC-USD",
      executionMode: "live",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("live");
    expect(result.value).not.toHaveProperty("apiKeyId");
    expect(result.value).not.toHaveProperty("privateKeyPem");
  });
});
