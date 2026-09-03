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

describe("configuration multi-produits (dao #24)", () => {
  it("normalise products[] à un élément vers la forme legacy strictement identique (INV-P6)", () => {
    const legacy = parseAgentConfiguration({
      productId: "btc-usd",
      strategyIds: ["rsi-reversion"],
      risk: { maxOrderNotional: 500 },
    });
    const fromProducts = parseAgentConfiguration({
      products: [{ productId: "BTC-USD", risk: { maxOrderNotional: 500 } }],
      strategyIds: ["rsi-reversion"],
    });
    expect(legacy.ok).toBe(true);
    expect(fromProducts.ok).toBe(true);
    if (!legacy.ok || !fromProducts.ok) return;
    expect(fromProducts.value).toEqual(legacy.value);
    expect(JSON.stringify(fromProducts.value)).toBe(
      JSON.stringify(legacy.value),
    );
    expect(Object.keys(fromProducts.value)).not.toContain("products");
    expect(Object.keys(fromProducts.value)).not.toContain("portfolioRisk");
  });

  it("ne modifie aucune clé de la forme legacy sans products[]", () => {
    const result = parseAgentConfiguration({ productId: "BTC-USD" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).toEqual([
      "productId",
      "timeframe",
      "strategyIds",
      "intervalSeconds",
      "maxMarketStalenessMs",
      "candleLimit",
      "initialCapital",
      "maxDecisionNotional",
      "minNetQuantity",
      "executionMode",
      "sizingPolicy",
      "indicators",
      "risk",
      "broker",
    ]);
  });

  it("produit une configuration multi-produits triée, figée et paper (N ≥ 2)", () => {
    const result = configurationModule.parseMultiProductAgentConfiguration({
      executionMode: "paper",
      strategyIds: ["ema-cross"],
      portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 2_000 },
      products: [
        { productId: "eth-usd", risk: { maxOrderNotional: 1_000 } },
        { productId: "BTC-USD" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.executionMode).toBe("paper");
    expect(result.value.products.map((slot) => slot.productId)).toEqual([
      "BTC-USD",
      "ETH-USD",
    ]);
    expect(result.value.products[0]?.risk).toMatchObject({
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
    });
    expect(result.value.products[1]?.risk.maxOrderNotional).toBe(1_000);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.products)).toBe(true);
    expect(Object.isFrozen(result.value.portfolioRisk)).toBe(true);
    expect(Object.isFrozen(result.value.products[0])).toBe(true);
  });

  it("accepte N = 1 sans plafonds consolidés via l'entrée multi (plafonds inutiles à un produit)", () => {
    const result = configurationModule.parseMultiProductAgentConfiguration({
      products: [{ productId: "BTC-USD" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.products).toHaveLength(1);
    expect("portfolioRisk" in result.value).toBe(false);
  });

  it("refuse fail-closed le multi-produits à la porte runtime (N ≥ 2)", () => {
    const result = parseAgentConfiguration({
      products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
      portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 2_000 },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "MULTI_PRODUCT_UNSUPPORTED" },
    });
  });

  it("refuse le multi-produits hors paper (INV-P7)", () => {
    const portfolioRisk = { maxGrossExposure: 30_000, maxDailyLoss: 2_000 };
    expect(
      parseAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
        portfolioRisk,
        executionMode: "live",
      }),
    ).toEqual({
      ok: false,
      error: { code: "MULTI_PRODUCT_LIVE_UNSUPPORTED" },
    });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
        portfolioRisk,
        executionMode: "perp",
      }),
    ).toEqual({
      ok: false,
      error: { code: "MULTI_PRODUCT_LIVE_UNSUPPORTED" },
    });
  });

  it("refuse products[] avec productId, vide, dupliqué, trop nombreux ou sans plafonds consolidés", () => {
    const portfolioRisk = { maxGrossExposure: 30_000, maxDailyLoss: 2_000 };
    expect(
      parseAgentConfiguration({
        products: [{ productId: "BTC-USD" }],
        productId: "ETH-USD",
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [],
        portfolioRisk,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [
          { productId: "BTC-USD" },
          { productId: "BTC-USD", risk: { maxOrderNotional: 100 } },
        ],
        portfolioRisk,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: Array.from(
          { length: configurationModule.MAX_AGENT_PRODUCTS + 1 },
          (_, index) => ({
            productId: `P${index}-USD`,
          }),
        ),
        portfolioRisk,
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
  });

  it("refuse le risk top-level en multi-produits (budget par produit uniquement)", () => {
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
        portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 2_000 },
        risk: { maxOrderNotional: 100 },
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_CONFIGURATION" } });
  });

  it("refuse un identifiant de produit invalide et un candleLimit insuffisant en multi-produits", () => {
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [{ productId: "not-a-product" }],
        portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 2_000 },
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_PRODUCT_ID" } });
    expect(
      configurationModule.parseMultiProductAgentConfiguration({
        products: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }],
        portfolioRisk: { maxGrossExposure: 30_000, maxDailyLoss: 2_000 },
        candleLimit: 5,
        strategyIds: ["breakout"],
      }),
    ).toEqual({ ok: false, error: { code: "INSUFFICIENT_CANDLE_LIMIT" } });
  });

  it("admet en paper une configuration mono-produit normalisée depuis products[]", () => {
    const result = parseAgentConfiguration({
      products: [{ productId: "BTC-USD" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(admit(result.value)).toEqual({ status: "APPROVED" });
  });
});
