import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import type { RegimeFilterPolicy, RegimePermissions } from "@dodash/models";
import {
  createStrategyRegistry,
  type Strategy,
  type StrategyRegistry,
} from "@dodash/strategies";

import {
  replayBacktest,
  type BacktestConfig,
  type PreparedBacktestIndicators,
} from "../src/index.js";

const product = createProductId("BTC-USD");
if (!product.ok) throw new Error("invalid product fixture");

const indicators = {
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

const strategyWithId = (id: string): Strategy => ({
  id,
  evaluate: (context) => {
    const buy = context.candles.length === 3;
    const result = createSignal({
      strategyId: id,
      productId: context.productId,
      side: buy ? "BUY" : "HOLD",
      confidence: buy ? 1 : 0,
      suggestedSize: buy ? 1 : 0,
      reasonCode: buy ? "TEST_BUY" : "TEST_HOLD",
    });
    return result.ok
      ? result
      : {
          ok: false as const,
          error: {
            code: "INVALID_STRATEGY_SIGNAL" as const,
            strategyId: id,
            cause: result.error,
          },
        };
  },
});

const registryWith = (ids: readonly string[]): StrategyRegistry => {
  const registry = createStrategyRegistry(ids.map(strategyWithId));
  if (!registry.ok) throw new Error("invalid strategy fixture");
  return registry.value;
};

interface SnapshotTuning {
  readonly emaFast: number;
  readonly emaSlow: number;
}

const preparedFor = (
  candles: readonly Candle[],
  tuning: SnapshotTuning,
): PreparedBacktestIndicators => ({
  config: indicators,
  snapshots: candles.map((candle, index) =>
    index < 2
      ? null
      : {
          snapshotId: `snapshot-${index}`,
          candleClosedAt: candle.start,
          rsi: 50,
          emaFast: tuning.emaFast,
          emaSlow: tuning.emaSlow,
          macd: 1,
          atr: 2,
          historicalVolatility: 0,
          momentum: 1,
          periodicReturns: { "1": 0 },
          ohlcvVwap: 100,
          tradeVwap: null,
          orderBookVwap: null,
          bidAskSpread: null,
          relativeVolume: 1,
          volumeSpike: false,
          volumeTrend: 0,
          vwapDeviation: 0,
          trendStrength: 20,
        },
  ),
});

const baseCandles: Candle[] = [
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 180_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 240_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
];

const bullishPolicy = {
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 1,
  confirmationCount: 1,
} as const;

const config = (
  strategies: StrategyRegistry,
  regimeFilter?: RegimeFilterPolicy,
  regimePermissions?: RegimePermissions,
): BacktestConfig => ({
  runId: "regime-gating-test",
  agentId: "regime-gating-agent",
  productId: product.value,
  intervalMs: 60_000,
  initialCapital: 10_000,
  maxDecisionNotional: 5_000,
  minNetQuantity: 0.0001,
  indicators,
  strategies,
  risk: {
    maxOrderNotional: 5_000,
    maxPositionNotional: 10_000,
    maxGrossExposure: 10_000,
    maxDailyLoss: 5_000,
    cooldownMs: 0,
    stopLossBps: 100,
    takeProfitBps: 200,
  },
  broker: { feeBps: 0, slippageBps: 0 },
  ...(regimeFilter === undefined ? {} : { regimeFilter }),
  ...(regimePermissions === undefined ? {} : { regimePermissions }),
});

// warmup = 3 → bougies de décision = indices 2, 3, 4 (3 observations, 3 signaux
// émis par stratégie : BUY à l'indice 2 puis HOLD).

describe("replayBacktest — gating par régime", () => {
  it("sans regimeFilter, regimeGating est null et les signaux passent (IG6)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"])),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.regimeGating).toBeNull();
    expect(result.value.trades.length).toBeGreaterThanOrEqual(1);
  });

  it("une politique invalide est rejetée par INVALID_BACKTEST_CONFIG", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"]), {
        ...bullishPolicy,
        thresholdBps: 0,
      }),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("regimePermissions personnalisée autorise une stratégie inconnue de la table par défaut", async () => {
    // custom-strategy est absente de la table par défaut (deny), mais
    // première dans la table fournie (allow) — prouve que la config
    // câble bien l'argument permissions du résolveur.
    const custom = {
      BULLISH: ["custom-strategy"],
      BEARISH: [],
      RANGE: [],
    } as const;
    const denied = await replayBacktest(
      baseCandles,
      config(registryWith(["custom-strategy"]), bullishPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!denied.ok) throw new Error(JSON.stringify(denied.error));
    expect(denied.value.trades).toHaveLength(0);

    const allowed = await replayBacktest(
      baseCandles,
      config(registryWith(["custom-strategy"]), bullishPolicy, custom),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!allowed.ok) throw new Error(JSON.stringify(allowed.error));
    expect(allowed.value.trades.length).toBeGreaterThanOrEqual(1);
  });

  it("une table de permissions incomplète est rejetée (INVALID_BACKTEST_CONFIG)", async () => {
    const incomplete = {
      BULLISH: ["ema-cross"],
    } as unknown as RegimePermissions;
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"]), bullishPolicy, incomplete),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("regimePermissions sans regimeFilter est rejetée (le gating doit exister)", async () => {
    const custom = {
      BULLISH: ["ema-cross"],
      BEARISH: [],
      RANGE: [],
    } as const;
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"]), undefined, custom),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("en warming-up, tous les signaux sont filtrés (deny-by-default)", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"]), {
        ...bullishPolicy,
        minObservations: 50,
      }),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const gating = result.value.regimeGating;
    expect(gating).not.toBeNull();
    if (gating === null) return;
    expect(gating.finalRegime).toBeNull();
    expect(gating.observationsFed).toBe(3);
    expect(gating.signalsPassed).toBe(0);
    expect(gating.signalsFiltered).toBe(3);
    // INV-P6 : aucune décision sous régime observé → compteurs nuls.
    expect(gating.passedByRegime).toEqual({ BULLISH: 0, BEARISH: 0, RANGE: 0 });
    expect(gating.deniedByRegime).toEqual({ BULLISH: 0, BEARISH: 0, RANGE: 0 });
    expect(result.value.trades).toHaveLength(0);
  });

  it("BULLISH confirmé autorise ema-cross et bloque rsi-reversion", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross", "rsi-reversion"]), bullishPolicy),
      preparedFor(baseCandles, { emaFast: 2, emaSlow: 1 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const gating = result.value.regimeGating;
    expect(gating).not.toBeNull();
    if (gating === null) return;
    expect(gating.finalRegime).toBe("BULLISH");
    expect(gating.observationsFed).toBe(3);
    expect(gating.signalsPassed).toBe(3);
    expect(gating.signalsFiltered).toBe(3);
    expect(gating.deniedByStrategy).toEqual({ "rsi-reversion": 3 });
    // INV-P6 : régime de décision BULLISH pour les 6 décisions.
    expect(gating.passedByRegime).toEqual({ BULLISH: 3, BEARISH: 0, RANGE: 0 });
    expect(gating.deniedByRegime).toEqual({ BULLISH: 3, BEARISH: 0, RANGE: 0 });
    expect(result.value.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.value.finalPortfolio.positionQuantity).toBeGreaterThan(0);
  });

  it("BEARISH confirmé autorise rsi-reversion et bloque breakout", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["rsi-reversion", "breakout"]), bullishPolicy),
      preparedFor(baseCandles, { emaFast: 1, emaSlow: 2 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const gating = result.value.regimeGating;
    expect(gating).not.toBeNull();
    if (gating === null) return;
    expect(gating.finalRegime).toBe("BEARISH");
    expect(gating.signalsPassed).toBe(3);
    expect(gating.signalsFiltered).toBe(3);
    expect(gating.deniedByStrategy).toEqual({ breakout: 3 });
    // INV-P6 : régime de décision BEARISH pour les 6 décisions.
    expect(gating.passedByRegime).toEqual({ BULLISH: 0, BEARISH: 3, RANGE: 0 });
    expect(gating.deniedByRegime).toEqual({ BULLISH: 0, BEARISH: 3, RANGE: 0 });
    expect(result.value.trades.length).toBeGreaterThanOrEqual(1);
  });

  // NB : REGIME_FILTER_FAILURE (IG5) est une branche défensive — unreachable
  // via l'API publique car INVALID_BACKTEST_CONFIG et INVALID_PREPARED_INDICATORS
  // rejettent toute entrée qui ferait échouer la machine. Les transitions vers
  // "failed" sont couvertes dans models/regime-filter.machine.test.ts.
  it("des EMAs invalides ne nourrissent pas la machine : deny-by-default", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(["ema-cross"]), bullishPolicy),
      preparedFor(baseCandles, { emaFast: 0, emaSlow: 1 }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const gating = result.value.regimeGating;
    expect(gating).not.toBeNull();
    if (gating === null) return;
    expect(gating.observationsFed).toBe(0);
    expect(gating.finalRegime).toBeNull();
    expect(gating.signalsPassed).toBe(0);
    expect(gating.signalsFiltered).toBe(3);
    expect(result.value.trades).toHaveLength(0);
  });
});
