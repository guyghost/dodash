import { describe, expect, it } from "vitest";

import { createProductId, type Candle } from "@dodash/domain";
import type { IndicatorSnapshot } from "@dodash/indicators-prolog";

import {
  createBreakoutStrategy,
  createEmaBandTrendStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
} from "../src/index.js";

const productResult = createProductId("BTC-USD");
if (!productResult.ok) throw new Error("invalid fixture product");

const snapshot = (overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot => ({
  snapshotId: "snapshot",
  candleClosedAt: 1_000,
  rsi: 50,
  emaFast: 100,
  emaSlow: 100,
  macd: 0,
  atr: 2,
  historicalVolatility: 0,
  momentum: 0,
  periodicReturns: { "1": 0 },
  ohlcvVwap: 100,
  tradeVwap: null,
  orderBookVwap: null,
  bidAskSpread: null,
  relativeVolume: 1,
  volumeSpike: false,
  volumeTrend: 0,
  vwapDeviation: 0,
  trendStrength: 0,
  ...overrides,
});

const candles = (closes: readonly number[]): Candle[] =>
  closes.map((close, index) => ({
    start: index * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  }));

const context = (overrides: Record<string, unknown> = {}) => ({
  productId: productResult.value,
  candles: candles([100, 101, 102, 103]),
  indicators: snapshot(),
  previousIndicators: null,
  ...overrides,
});

describe("strategies", () => {
  it("achète un RSI survendu", () => {
    const strategy = createRsiReversionStrategy({
      oversold: 30,
      overbought: 70,
      baseSize: 0.01,
    });
    const result = strategy.evaluate(context({ indicators: snapshot({ rsi: 20 }) }));
    expect(result.ok && result.value.side).toBe("BUY");
    expect(result.ok && result.value.reasonCode).toBe("RSI_OVERSOLD");
  });

  it("n’agit que sur un croisement EMA confirmé", () => {
    const strategy = createEmaCrossStrategy({ baseSize: 0.01 });
    const result = strategy.evaluate(
      context({
        previousIndicators: snapshot({ emaFast: 99, emaSlow: 100 }),
        indicators: snapshot({ emaFast: 101, emaSlow: 100 }),
      }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
  });

  it("détecte un breakout contre la fenêtre précédente", () => {
    const strategy = createBreakoutStrategy({ lookback: 3, baseSize: 0.01 });
    const result = strategy.evaluate(
      context({ candles: candles([100, 101, 102, 110]) }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
  });

  it("évalue le registre dans un ordre stable", () => {
    const registry = createStrategyRegistry([
      createRsiReversionStrategy({
        id: "z-rsi",
        oversold: 30,
        overbought: 70,
        baseSize: 0.01,
      }),
      createEmaCrossStrategy({ id: "a-ema", baseSize: 0.01 }),
    ]);
    expect(registry.ok && registry.value.ids).toEqual(["a-ema", "z-rsi"]);
    const result = registry.ok ? registry.value.evaluateAll(context()) : registry;
    expect(result.ok && result.value.map((signal) => signal.strategyId)).toEqual([
      "a-ema",
      "z-rsi",
    ]);
  });

  it("refuse les identifiants de stratégie dupliqués", () => {
    const result = createStrategyRegistry([
      createEmaCrossStrategy({ id: "same", baseSize: 0.01 }),
      createEmaCrossStrategy({ id: "same", baseSize: 0.02 }),
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: "DUPLICATE_STRATEGY_ID", strategyId: "same" },
    });
  });
});

describe("ema-band-trend (models/ema-band-trend.md)", () => {
  const strategy = createEmaBandTrendStrategy({ baseSize: 1 });

  it("id par défaut : ema-band-trend", () => {
    expect(strategy.id).toBe("ema-band-trend");
  });

  it("INV-T4 : BUY au franchissement strict de la bande haussière (+100 bps)", () => {
    // previous 90 bps, current 150 bps → franchissement strict.
    const previous = snapshot({ emaFast: 100.9, emaSlow: 100 });
    const current = snapshot({ emaFast: 101.5, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: previous }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
    expect(result.ok && result.value.reasonCode).toBe("EMA_BAND_BULL_ENTRY");
    // |150|/100 caplé à 1 — un franchissement strict est toujours ≥ 1.
    expect(result.ok && result.value.confidence).toBe(1);
    expect(result.ok && result.value.suggestedSize).toBe(1);
  });

  it("INV-T4 : SELL au franchissement strict de la bande baissière (−100 bps)", () => {
    // previous exactement au seuil bas (−100 bps ≥ −100), current −150 bps.
    const previous = snapshot({ emaFast: 99, emaSlow: 100 });
    const current = snapshot({ emaFast: 98.5, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: previous }),
    );
    expect(result.ok && result.value.side).toBe("SELL");
    expect(result.ok && result.value.reasonCode).toBe("EMA_BAND_BEAR_EXIT");
  });

  it("INV-T4 : au seuil exactement (+100 bps) ⇒ HOLD — au-seuil = RANGE, miroir du gate", () => {
    // 101/100 = spread mathématiquement exact de 100 bps : pas de BUY
    // (inégalité stricte, même convention que classifyRegimeObservation).
    const previous = snapshot({ emaFast: 100.9, emaSlow: 100 });
    const current = snapshot({ emaFast: 101, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: previous }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("EMA_BAND_NO_EVENT");
  });

  it("INV-T4 : zéro émission répétée à l’intérieur de la bande", () => {
    // previous 150 bps, current 160 bps : déjà au-dessus, pas de nouveau BUY.
    const previous = snapshot({ emaFast: 101.5, emaSlow: 100 });
    const current = snapshot({ emaFast: 101.6, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: previous }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.suggestedSize).toBe(0);
  });

  it("INV-T2 : warm-up (previous null) ⇒ HOLD EMA_BAND_WARMUP", () => {
    const current = snapshot({ emaFast: 101.5, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: null }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("EMA_BAND_WARMUP");
  });

  it("INV-T2 : EMA non positive ⇒ HOLD fail-closed (EMA_BAND_WARMUP)", () => {
    const previous = snapshot({ emaFast: 0, emaSlow: 0 });
    const current = snapshot({ emaFast: 101.5, emaSlow: 100 });
    const result = strategy.evaluate(
      context({ indicators: current, previousIndicators: previous }),
    );
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("EMA_BAND_WARMUP");
  });

  it("INV-T3 : config invalide (baseSize 0 / NaN) ⇒ INVALID_STRATEGY_CONFIG", () => {
    for (const baseSize of [0, Number.NaN]) {
      const invalid = createEmaBandTrendStrategy({ baseSize });
      const result = invalid.evaluate(context());
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_STRATEGY_CONFIG", strategyId: "ema-band-trend" },
      });
    }
  });

  it("INV-T1 : ne lit jamais context.candles", () => {
    // Proxy qui explose à toute lecture : la décision doit réussir sans
    // toucher aux candles (stratégie pure sur snapshots uniquement).
    const forbiddenCandles = new Proxy([] as Candle[], {
      get(_target, property) {
        throw new Error(`context.candles lu (${String(property)})`);
      },
    });
    const previous = snapshot({ emaFast: 100.9, emaSlow: 100 });
    const current = snapshot({ emaFast: 101.5, emaSlow: 100 });
    const result = strategy.evaluate(
      context({
        candles: forbiddenCandles,
        indicators: current,
        previousIndicators: previous,
      }),
    );
    expect(result.ok && result.value.side).toBe("BUY");
  });
});

describe("ema-cross — paire de signal (models/ema-signal-decoupling.md)", () => {
  const strategy = createEmaCrossStrategy({ baseSize: 1 });

  it("INV-E3 : suit la paire de signal quand elle est active des deux côtés", () => {
    // Historique 12/26 sans cross ; signal 5/13 en cross-up dans un
    // BULLISH établi — la décision doit suivre la paire de signal.
    const previous = snapshot({
      emaFast: 110,
      emaSlow: 100,
      signalEmaFast: 98,
      signalEmaSlow: 99,
    });
    const current = snapshot({
      emaFast: 111,
      emaSlow: 100,
      signalEmaFast: 100,
      signalEmaSlow: 99,
    });
    const result = strategy.evaluate(context({ indicators: current, previousIndicators: previous }));
    expect(result.ok && result.value.side).toBe("BUY");
    expect(result.ok && result.value.reasonCode).toBe("EMA_CROSS_UP");
  });

  it("INV-E3 : la paire historique pilote seul quand la paire de signal est absente (V1)", () => {
    // Cross-up sur 12/26, aucune paire de signal → comportement V1 exact.
    const previous = snapshot({ emaFast: 99, emaSlow: 100 });
    const current = snapshot({ emaFast: 101, emaSlow: 100 });
    const result = strategy.evaluate(context({ indicators: current, previousIndicators: previous }));
    expect(result.ok && result.value.side).toBe("BUY");
  });

  it("INV-E3 : un cross de la paire historique est ignoré quand la paire de signal est active", () => {
    // 12/26 croise vers le bas pendant que 5/13 reste orientée haut :
    // la décision suit exclusivement la paire de signal → HOLD.
    const previous = snapshot({
      emaFast: 100,
      emaSlow: 100,
      signalEmaFast: 105,
      signalEmaSlow: 104,
    });
    const current = snapshot({
      emaFast: 99,
      emaSlow: 100,
      signalEmaFast: 106,
      signalEmaSlow: 104,
    });
    const result = strategy.evaluate(context({ indicators: current, previousIndicators: previous }));
    expect(result.ok && result.value.side).toBe("HOLD");
  });

  it("INV-E6 : warm-up (previous null) ⇒ HOLD même avec paire active", () => {
    const current = snapshot({
      signalEmaFast: 100,
      signalEmaSlow: 99,
    });
    const result = strategy.evaluate(context({ indicators: current, previousIndicators: null }));
    expect(result.ok && result.value.side).toBe("HOLD");
    expect(result.ok && result.value.reasonCode).toBe("EMA_WARMUP");
  });

  it("INV-E3 : bascule warm-up de la paire (current active, previous inactif) ⇒ paire historique", () => {
    // Cas structurellement impossible sous INV-E2 (requiredIndicatorCandles
    // couvre la paire), mais fail-closed : la décision ne mélange jamais
    // les paires — previous inactif ⇒ paire historique des deux côtés.
    const previous = snapshot({
      emaFast: 100,
      emaSlow: 100,
      signalEmaFast: 0,
      signalEmaSlow: 0,
    });
    const current = snapshot({
      emaFast: 102,
      emaSlow: 100,
      signalEmaFast: 104,
      signalEmaSlow: 103,
    });
    const result = strategy.evaluate(context({ indicators: current, previousIndicators: previous }));
    expect(result.ok && result.value.side).toBe("BUY");
  });
});
