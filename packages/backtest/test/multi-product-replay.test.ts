import { describe, expect, it } from "vitest";

import { ok, createProductId, type Candle } from "@dodash/domain";
import {
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

import {
  replayMultiProductBacktest,
  type MultiProductBacktestConfig,
} from "../src/index.js";

const productId = (raw: string) => {
  const product = createProductId(raw);
  if (!product.ok) throw new Error("invalid product fixture");
  return product.value;
};

const testIndicatorConfig = {
  rsiPeriod: 2,
  emaFastPeriod: 2,
  emaSlowPeriod: 3,
  atrPeriod: 2,
  historicalVolatilityPeriod: 2,
  momentumPeriod: 1,
  returnPeriods: [1],
  vwapPeriod: 2,
  relativeVolumePeriod: 1,
  volumeSpikeThreshold: 2,
  volumeTrendPeriod: 2,
  trendStrengthPeriod: 1,
} as const;

const candles = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  }));

const fixedSideStrategy = (side: "BUY" | "HOLD"): Strategy => ({
  id: "test-signal",
  evaluate: (context) =>
    ok({
      strategyId: "test-signal",
      productId: context.productId,
      side,
      confidence: 1,
      suggestedSize: 1,
      reasonCode: "test",
    }),
});

const registry = (side: "BUY" | "HOLD") => {
  const result = createStrategyRegistry([fixedSideStrategy(side)]);
  if (!result.ok) throw new Error("invalid strategy fixture");
  return result.value;
};

const productRisk = {
  maxOrderNotional: 1_000,
  maxPositionNotional: 150,
  maxGrossExposure: 10_000,
  maxDailyLoss: 500,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
} as const;

const baseConfig = (): MultiProductBacktestConfig => ({
  runId: "multi-run-1",
  agentId: "agent-1",
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  broker: { feeBps: 0, slippageBps: 0 },
  portfolioRisk: { maxGrossExposure: 150, maxDailyLoss: 1_000 },
  products: [
    {
      productId: productId("BTC-USD"),
      candles: candles([100, 101, 102, 103, 104, 105, 106, 107]),
      strategies: registry("BUY"),
      indicators: testIndicatorConfig,
      risk: productRisk,
    },
    {
      productId: productId("ETH-USD"),
      candles: candles([100, 101, 102, 103, 104, 105, 106, 107]),
      strategies: registry("BUY"),
      indicators: testIndicatorConfig,
      risk: productRisk,
    },
  ],
});

describe("replayMultiProductBacktest", () => {
  it("rejette la somme dépassant le plafond consolidé : le premier produit trié trade, l'autre est bloqué", async () => {
    const result = await replayMultiProductBacktest(baseConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.perProduct).toHaveLength(2);
    expect(result.value.perProduct[0]?.productId).toBe("BTC-USD");
    expect(result.value.perProduct[1]?.productId).toBe("ETH-USD");
    // BTC-USD (premier en ordre trié) accumule une position ; ETH-USD est
    // rejeté par le plafond consolidé : aucune position, aucun trade.
    expect(result.value.perProduct[0]?.finalPosition.quantity).toBeGreaterThan(0);
    expect(result.value.perProduct[0]?.trades.length).toBeGreaterThan(0);
    expect(result.value.perProduct[1]?.finalPosition.quantity).toBe(0);
    expect(result.value.perProduct[1]?.trades).toHaveLength(0);
    expect(result.value.perProduct[1]?.realizedPnl).toBe(0);
    expect(result.value.trades).toHaveLength(
      result.value.perProduct[0]?.trades.length ?? 0,
    );
    expect(result.value.finalPortfolio.positions["ETH-USD"]).toEqual({
      quantity: 0,
      averagePrice: 0,
    });
  });

  it("garantit la quiescence : un produit sans signaux n'empêche pas les autres de trader", async () => {
    const config = baseConfig();
    const btc = config.products[0];
    const eth = config.products[1];
    if (btc === undefined || eth === undefined) throw new Error("bad fixture");
    const result = await replayMultiProductBacktest({
      ...config,
      products: [
        { ...btc, strategies: registry("HOLD") },
        { ...eth, strategies: registry("BUY") },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.perProduct[0]?.finalPosition.quantity).toBe(0);
    expect(result.value.perProduct[0]?.trades).toHaveLength(0);
    expect(result.value.perProduct[1]?.finalPosition.quantity).toBeGreaterThan(0);
    expect(result.value.perProduct[1]?.trades.length).toBeGreaterThan(0);
    // Aucun capital n'est bloqué par le produit quiescent.
    expect(result.value.metrics.grossTradedNotional).toBeGreaterThan(0);
  });

  it("est déterministe : le même rejeu produit les mêmes résultats", async () => {
    const first = await replayMultiProductBacktest(baseConfig());
    const second = await replayMultiProductBacktest(baseConfig());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });

  it("refuse des séries désalignées sans rejeu partiel", async () => {
    const config = baseConfig();
    const btc = config.products[0];
    if (btc === undefined) throw new Error("bad fixture");
    const result = await replayMultiProductBacktest({
      ...config,
      products: [
        btc,
        {
          productId: productId("ETH-USD"),
          candles: candles([100, 101, 102]),
          strategies: registry("BUY"),
          indicators: testIndicatorConfig,
          risk: productRisk,
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "MISALIGNED_PRODUCT_CANDLES" },
    });
  });

  it("refuse une configuration invalide (produits dupliqués, liste vide, plafonds non positifs)", async () => {
    const duplicated = baseConfig();
    const eth = duplicated.products[1];
    if (eth === undefined) throw new Error("bad fixture");
    expect(
      await replayMultiProductBacktest({
        ...duplicated,
        products: [duplicated.products[0] ?? eth, { ...eth, productId: productId("BTC-USD") }],
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_MULTI_PRODUCT_CONFIG" } });

    expect(
      await replayMultiProductBacktest({
        ...duplicated,
        products: [],
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_MULTI_PRODUCT_CONFIG" } });

    expect(
      await replayMultiProductBacktest({
        ...duplicated,
        portfolioRisk: { maxGrossExposure: 0, maxDailyLoss: 1_000 },
      }),
    ).toEqual({ ok: false, error: { code: "INVALID_MULTI_PRODUCT_CONFIG" } });
  });
});
