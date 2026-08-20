import { describe, expect, it } from "vitest";

import * as configurationModule from "../src/configuration.js";
import type { AgentConfiguration } from "../src/configuration.js";

const { parseAgentConfiguration } = configurationModule;

const admit = (input: unknown) => {
  const parsed = parseAgentConfiguration(input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return null;
  const candidate = configurationModule as Record<string, unknown>;
  expect(typeof candidate.admitAgentConfiguration).toBe("function");
  if (typeof candidate.admitAgentConfiguration !== "function") return null;
  return (
    candidate.admitAgentConfiguration as (
      value: AgentConfiguration,
    ) => { readonly status: string; readonly reasonCode?: string }
  )(parsed.value);
};

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
      productId: "GRT-USD",
      executionMode: "live",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("live");
    expect(result.value).toMatchObject({
      timeframe: "ONE_DAY",
      strategyIds: ["breakout", "ema-cross", "rsi-reversion"],
      intervalSeconds: 3_600,
      maxMarketStalenessMs: 7_200_000,
      candleLimit: 200,
      initialCapital: 10_000,
      maxDecisionNotional: 600,
      minNetQuantity: 0.000_001,
      sizingPolicy: {
        type: "TARGET_SIGNAL_NOTIONAL",
        targetSignalNotional: 1_000,
        confidenceCalibration: "POWER_THIRD",
      },
      risk: {
        maxOrderNotional: 600,
        maxPositionNotional: 10_000,
        maxGrossExposure: 20_000,
        maxDailyLoss: 1_000,
        cooldownMs: 0,
        stopLossBps: 150,
        takeProfitBps: 300,
      },
    });
    expect(result.value).not.toHaveProperty("apiKeyId");
    expect(result.value).not.toHaveProperty("privateKeyPem");
  });

  it("preserves an explicit live-policy divergence for admission to reject", () => {
    const result = parseAgentConfiguration({
      productId: "GRT-USD",
      executionMode: "live",
      maxDecisionNotional: 601,
      risk: { maxOrderNotional: 601 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxDecisionNotional).toBe(601);
    expect(result.value.risk.maxOrderNotional).toBe(601);
    expect(result.value.risk.maxDailyLoss).toBe(1_000);
  });

  it("admits paper configurations without applying the live envelope", () => {
    expect(admit({ productId: "BTC-USD" })).toEqual({ status: "APPROVED" });
  });

  it("admits only an exact configured live product envelope", () => {
    expect(admit({ productId: "GRT-USD", executionMode: "live" })).toEqual({
      status: "APPROVED",
    });
    expect(admit({ productId: "BTC-USD", executionMode: "live" })).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_PRODUCT_NOT_ALLOWED",
    });
    expect(
      admit({
        productId: "GRT-USD",
        executionMode: "live",
        maxDecisionNotional: 601,
      }),
    ).toEqual({
      status: "REJECTED",
      reasonCode: "LIVE_POLICY_MISMATCH",
    });
  });
});
