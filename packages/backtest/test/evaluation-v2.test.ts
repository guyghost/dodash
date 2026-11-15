import { describe, expect, it } from "vitest";

import {
  BENCHMARK_REGIME_THRESHOLD,
  benchmarkRegime,
  evaluateV2,
} from "../src/evaluation-v2.js";
import type { BacktestMetrics } from "../src/metrics.js";

const baseMetrics = (overrides?: Partial<BacktestMetrics>): BacktestMetrics =>
  Object.freeze({
    pnl: -150,
    realizedPnl: 50,
    unrealizedPnl: -200,
    fees: 8.95,
    grossTradedNotional: 14_920,
    turnover: 1.492,
    totalReturn: -0.15,
    winRate: 1,
    winRateLiquidative: 0.833_333_333_333_333_4,
    profitFactor: 20.01,
    sharpe: -0.075,
    maxDrawdown: 0.350_2,
    ...overrides,
  });

const baseBenchmark = { pnl: -2_748.14, totalReturn: -0.274_814 };

describe("régime du benchmark (seuil figé du modèle)", () => {
  it("vaut BAISSIER pour un rendement strictement négatif", () => {
    expect(benchmarkRegime(-0.274_8)).toBe("BAISSIER");
  });

  it("vaut HAUSSIER pour un rendement nul ou positif", () => {
    expect(benchmarkRegime(0)).toBe("HAUSSIER");
    expect(benchmarkRegime(1.15)).toBe("HAUSSIER");
  });

  it("expose le seuil figé à zéro, cohérent avec le modèle", () => {
    expect(BENCHMARK_REGIME_THRESHOLD).toBe(0);
    expect(benchmarkRegime(BENCHMARK_REGIME_THRESHOLD - Number.EPSILON)).toBe(
      "BAISSIER",
    );
  });

  it("est dérivé du benchmark du run, jamais d'un paramètre déclaré", () => {
    const entry = evaluateV2("rsi-reversion", baseMetrics(), baseBenchmark);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value.benchmark.regime).toBe("BAISSIER");
      expect(entry.value.benchmark.totalReturn).toBe(-0.274_814);
    }
  });
});

describe("évaluation v2 — métriques primaires", () => {
  it("rapporte exactement les six métriques primaires du modèle", () => {
    const entry = evaluateV2("rsi-reversion", baseMetrics(), baseBenchmark);
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.primary).toEqual({
      pnlUsd: -150,
      totalReturn: -0.15,
      realizedPnlUsd: 50,
      unrealizedPnlUsd: -200,
      winRateLiquidative: 0.833_333_333_333_333_4,
      maxDrawdown: 0.350_2,
      sharpe: -0.075,
      turnover: 1.492,
      feesUsd: 8.95,
    });
  });

  it("accepte les métriques complètes d'un rapport de suite (INV-26 présente)", () => {
    const metrics = baseMetrics({ winRateLiquidative: 0.5 });
    const entry = evaluateV2("ema-cross", metrics, baseBenchmark);
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.primary.winRateLiquidative).toBe(0.5);
  });

  it("calcule l'excess comme métrique contextuelle, accompagnée du régime", () => {
    const entry = evaluateV2("rsi-reversion", baseMetrics(), baseBenchmark);
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.contextual.excessReturn).toBeCloseTo(0.124_814, 12);
    expect(entry.value.benchmark.regime).toBe("BAISSIER");
  });
});

describe("compatibilité de lecture des artefacts legacy (C3)", () => {
  it("lit un artefact sans win rate liquidatif : la valeur absente reste null", () => {
    const { winRateLiquidative: _omitted, ...legacy } = baseMetrics();
    const entry = evaluateV2("breakout", legacy, baseBenchmark);
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.primary.winRateLiquidative).toBeNull();
  });

  it("n'approxime jamais le win rate liquidatif par le win rate par fills", () => {
    const { winRateLiquidative: _omitted, ...legacy } = baseMetrics({
      winRate: 1,
    });
    const entry = evaluateV2("rsi-reversion", legacy, baseBenchmark);
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.primary.winRateLiquidative).not.toBe(1);
    expect(entry.value.primary.winRateLiquidative).toBeNull();
  });
});

describe("validation et erreurs", () => {
  it("refuse un identifiant de scénario vide", () => {
    const entry = evaluateV2("  ", baseMetrics(), baseBenchmark);
    expect(entry).toEqual({
      ok: false,
      error: { code: "INVALID_EVALUATION_V2_INPUT" },
    });
  });

  it("refuse un benchmark non fini : pas de régime sans benchmark mesuré", () => {
    const entry = evaluateV2("rsi-reversion", baseMetrics(), {
      pnl: Number.NaN,
      totalReturn: Number.NaN,
    });
    expect(entry).toEqual({
      ok: false,
      error: { code: "INVALID_EVALUATION_V2_INPUT" },
    });
  });

  it("refuse une métrique primaire non finie", () => {
    const entry = evaluateV2(
      "rsi-reversion",
      baseMetrics({ sharpe: Number.POSITIVE_INFINITY }),
      baseBenchmark,
    );
    expect(entry).toEqual({
      ok: false,
      error: { code: "INVALID_EVALUATION_V2_INPUT" },
    });
  });

  it("refuse un win rate liquidatif hors bornes", () => {
    const entry = evaluateV2(
      "rsi-reversion",
      baseMetrics({ winRateLiquidative: 1.5 }),
      baseBenchmark,
    );
    expect(entry).toEqual({
      ok: false,
      error: { code: "INVALID_EVALUATION_V2_INPUT" },
    });
  });

  it("refuse drawdown, turnover ou frais négatifs", () => {
    for (const overrides of [
      { maxDrawdown: -0.01 },
      { turnover: -1 },
      { fees: -0.5 },
    ]) {
      const entry = evaluateV2("breakout", baseMetrics(overrides), baseBenchmark);
      expect(entry).toEqual({
        ok: false,
        error: { code: "INVALID_EVALUATION_V2_INPUT" },
      });
    }
  });
});
