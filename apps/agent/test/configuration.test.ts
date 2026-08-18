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

  it("keeps live execution closed until its adapter is configured", () => {
    expect(
      parseAgentConfiguration({ productId: "BTC-USD", executionMode: "live" }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
  });
});
