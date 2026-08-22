import { describe, expect, it } from "vitest";

import { createProductId, createSignal, type Candle } from "@dodash/domain";
import type {
  ProtectiveExitPolicy,
  RegimeFilterPolicy,
} from "@dodash/models";
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

// Stratégy de test : BUY unique à l'index donné (longueur candles = index+1).
const buyAtStrategy = (id: string, index: number): Strategy => ({
  id,
  evaluate: (context) => {
    const buy = context.candles.length === index + 1;
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

const registryWith = (strategy: Strategy): StrategyRegistry => {
  const registry = createStrategyRegistry([strategy]);
  if (!registry.ok) throw new Error("invalid strategy fixture");
  return registry.value;
};

interface SnapshotTuning {
  readonly emaFast: number;
  readonly emaSlow: number;
}

const preparedTuned = (
  candles: readonly Candle[],
  tunings: readonly (SnapshotTuning | undefined)[],
): PreparedBacktestIndicators => ({
  config: indicators,
  snapshots: candles.map((candle, index) => {
    const tuning = tunings[index];
    if (index < 2 || tuning === undefined) return null;
    return {
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
    };
  }),
});

const baseCandles: Candle[] = [
  { start: 0, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 120_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 180_000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { start: 240_000, open: 100, high: 101, low: 85, close: 86, volume: 10 },
];

const dumpCandles: Candle[] = baseCandles.slice(0, 4).concat([
  { start: 240_000, open: 100, high: 101, low: 80, close: 81, volume: 10 },
]);

// ema 2/1 → BULLISH brut ; ema 1/2 → BEARISH brut (thresholdBps 100).
const instantPolicy = (
  overrides?: Partial<RegimeFilterPolicy>,
): RegimeFilterPolicy => ({
  mode: "EMA_THRESHOLD",
  thresholdBps: 100,
  minObservations: 1,
  confirmationCount: 1,
  ...overrides,
} as RegimeFilterPolicy);

const fixedArm = (stopLossBps: number, takeProfitBps: number) =>
  ({ mode: "FIXED_BPS", stopLossBps, takeProfitBps }) as const;

const regimeExitPolicy = (
  arms: Partial<{
    bullish: ReturnType<typeof fixedArm> | { mode: "NONE" };
    bearish: ReturnType<typeof fixedArm> | { mode: "NONE" };
    range: ReturnType<typeof fixedArm> | { mode: "NONE" };
    warmUp: ReturnType<typeof fixedArm> | { mode: "NONE" };
  }>,
): ProtectiveExitPolicy =>
  ({
    mode: "REGIME_CONDITIONAL",
    bullish: { mode: "NONE" },
    bearish: fixedArm(300, 600),
    range: fixedArm(300, 600),
    warmUp: fixedArm(300, 600),
    ...arms,
  }) as ProtectiveExitPolicy;

const config = (
  strategies: StrategyRegistry,
  protectiveExit: ProtectiveExitPolicy,
  regimeFilter: RegimeFilterPolicy | null = instantPolicy(),
): BacktestConfig => ({
  runId: "regime-exit-test",
  agentId: "regime-exit-agent",
  productId: product.value,
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
  protectiveExit,
  ...(regimeFilter === null ? {} : { regimeFilter }),
});

// Bougies de décision : indices 2, 3, 4 (warmup 3). Ordre par bougie :
// exits évaluées avec le plan ≤ N−1, observation régime N, replan effectif N+1.

describe("replayBacktest — sorties protectives REGIME_CONDITIONAL", () => {
  it("RE7 : REGIME_CONDITIONAL sans regimeFilter est INVALID_BACKTEST_CONFIG", async () => {
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(buyAtStrategy("ema-cross", 2)), regimeExitPolicy({}), null),
      preparedTuned(baseCandles, [undefined, undefined, { emaFast: 2, emaSlow: 1 }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_BACKTEST_CONFIG");
  });

  it("bras BULLISH NONE : position non protégée, aucun exit malgré le dump", async () => {
    // idx2 : BULLISH (2/1) → BUY ema-cross passe, fill à l'open idx3.
    // idx3 : BULLISH maintenu → bras NONE, aucun plan armé.
    // idx4 : low 85 → sans plan, aucune sortie protective.
    const result = await replayBacktest(
      dumpCandles,
      config(registryWith(buyAtStrategy("ema-cross", 2)), regimeExitPolicy({})),
      preparedTuned(dumpCandles, [
        undefined,
        undefined,
        { emaFast: 2, emaSlow: 1 },
        { emaFast: 2, emaSlow: 1 },
        { emaFast: 2, emaSlow: 1 },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.protectiveExits).toHaveLength(0);
    expect(result.value.finalPortfolio.positionQuantity).toBeGreaterThan(0);
  });

  it("transition BULLISH→BEARISH en position : armement, stop INTRABAR à la bougie suivante", async () => {
    // idx2 : BULLISH → BUY, fill idx3 (bras NONE, pas de plan).
    // idx3 close : BEARISH (1/2) → replan : armement stop/take depuis
    // avg entry 100 (1000/2000 bps → stop 90, take 120), armedAt idx3.
    // idx4 : open 100 > 90, low 85 ≤ 90 → STOP_LOSS INTRABAR (RE5).
    const policy = regimeExitPolicy({
      bullish: { mode: "NONE" },
      bearish: fixedArm(1000, 2000),
      range: fixedArm(1000, 2000),
      warmUp: fixedArm(1000, 2000),
    });
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(buyAtStrategy("ema-cross", 2)), policy),
      preparedTuned(baseCandles, [
        undefined,
        undefined,
        { emaFast: 2, emaSlow: 1 },
        { emaFast: 1, emaSlow: 2 },
        { emaFast: 1, emaSlow: 2 },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const exits = result.value.protectiveExits;
    expect(exits).toHaveLength(1);
    const exit = exits[0];
    if (exit === undefined) throw new Error("exit manquant");
    expect(exit.kind).toBe("STOP_LOSS");
    expect(exit.reason).toBe("INTRABAR");
    expect(exit.referencePrice).toBe(90); // RE4 : plan recalculé depuis avg entry courante
    expect(result.value.finalPortfolio.positionQuantity).toBe(0);
  });

  it("transition vers un bras NONE : annulation REGIME_CHANGED, position laissée ouverte", async () => {
    // idx2 : BEARISH (1/2) → BUY rsi-reversion passe (permis en BEARISH),
    // fill idx3 open → plan armé (bras BEARISH 300/600, stop 97).
    // idx3 close : BULLISH (2/1) → bras NONE → CANCEL(REGIME_CHANGED), pas de re-arm.
    // idx4 : low 80 ≤ 97 mais sans plan → aucune sortie, position conservée.
    const policy = regimeExitPolicy({
      bullish: { mode: "NONE" },
      bearish: fixedArm(300, 600),
      range: fixedArm(300, 600),
      warmUp: fixedArm(300, 600),
    });
    const result = await replayBacktest(
      dumpCandles,
      config(registryWith(buyAtStrategy("rsi-reversion", 2)), policy),
      preparedTuned(dumpCandles, [
        undefined,
        undefined,
        { emaFast: 1, emaSlow: 2 },
        { emaFast: 2, emaSlow: 1 },
        { emaFast: 2, emaSlow: 1 },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.protectiveExits).toHaveLength(0);
    expect(result.value.finalPortfolio.positionQuantity).toBeGreaterThan(0);
  });

  it("re-arm après transition : nouveaux niveaux depuis l'avg entry (RE4), stop déclenché", async () => {
    // Comme le test précédent, mais bras BULLISH FIXED 500/1000 :
    // re-arm à idx3 close → stop 95, take 110 depuis avg entry 100.
    // idx4 : low 80 ≤ 95 → STOP_LOSS INTRABAR à 95 (niveaux du NOUVEAU plan).
    const policy = regimeExitPolicy({
      bullish: fixedArm(500, 1000),
      bearish: fixedArm(300, 600),
      range: fixedArm(300, 600),
      warmUp: fixedArm(300, 600),
    });
    const result = await replayBacktest(
      dumpCandles,
      config(registryWith(buyAtStrategy("rsi-reversion", 2)), policy),
      preparedTuned(dumpCandles, [
        undefined,
        undefined,
        { emaFast: 1, emaSlow: 2 },
        { emaFast: 2, emaSlow: 1 },
        { emaFast: 2, emaSlow: 1 },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const exits = result.value.protectiveExits;
    expect(exits).toHaveLength(1);
    const exit = exits[0];
    if (exit === undefined) throw new Error("exit manquant");
    expect(exit.kind).toBe("STOP_LOSS");
    expect(exit.reason).toBe("INTRABAR");
    expect(exit.referencePrice).toBe(95);
    expect(result.value.finalPortfolio.positionQuantity).toBe(0);
  });

  it("flip de bras identiques : aucun replan, niveaux du plan d'origine conservés", async () => {
    // idx2 : BEARISH → BUY rsi-reversion, fill idx3 → plan stop 97 (300 bps).
    // idx3 close : RANGE (écart nul) → bras range identique 300/600 → pas de
    // replan (RE3) : le stop reste 97, calculé à l'armement initial.
    // idx4 : low 85 ≤ 97 → INTRABAR à 97 (niveaux d'origine, non recalculés).
    const policy = regimeExitPolicy({});
    const result = await replayBacktest(
      baseCandles,
      config(registryWith(buyAtStrategy("rsi-reversion", 2)), policy),
      preparedTuned(baseCandles, [
        undefined,
        undefined,
        { emaFast: 1, emaSlow: 2 },
        { emaFast: 1, emaSlow: 1 },
        { emaFast: 1, emaSlow: 2 },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const gating = result.value.regimeGating;
    expect(gating?.finalRegime).toBe("BEARISH");
    const exits = result.value.protectiveExits;
    expect(exits).toHaveLength(1);
    const exit = exits[0];
    if (exit === undefined) throw new Error("exit manquant");
    expect(exit.referencePrice).toBe(97);
  });
});
