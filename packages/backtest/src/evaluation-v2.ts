import { err, ok, type Result } from "@dodash/domain";

/**
 * Seuil figé du régime du benchmark (models/backtest-diagnostics.md,
 * « Évaluation v2 ») : rendement total du benchmark buy-and-hold `>= 0`
 * vaut `HAUSSIER`, `< 0` vaut `BAISSIER`. Le régime est calculé, jamais
 * déclaré à la main.
 */
export const BENCHMARK_REGIME_THRESHOLD = 0;

export type BenchmarkRegime = "HAUSSIER" | "BAISSIER";

export interface EvaluationV2MetricsInput {
  readonly pnl: number;
  readonly totalReturn: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  /**
   * INV-26 (models/backtest-run.md). Absent des artefacts legacy : la
   * lecture ne le reconstitue pas et le rapporte `null` (compat lecture,
   * models/backtest-diagnostics.md).
   */
  readonly winRateLiquidative?: number;
  readonly maxDrawdown: number;
  readonly sharpe: number;
  readonly turnover: number;
  readonly fees: number;
}

export interface EvaluationV2BenchmarkInput {
  readonly pnl: number;
  readonly totalReturn: number;
}

export interface EvaluationV2PrimaryMetrics {
  readonly pnlUsd: number;
  readonly totalReturn: number;
  readonly realizedPnlUsd: number;
  readonly unrealizedPnlUsd: number;
  readonly winRateLiquidative: number | null;
  readonly maxDrawdown: number;
  readonly sharpe: number;
  readonly turnover: number;
  readonly feesUsd: number;
}

export interface EvaluationV2ContextualMetrics {
  readonly excessReturn: number;
}

export interface EvaluationV2Entry {
  readonly scenarioId: string;
  readonly primary: EvaluationV2PrimaryMetrics;
  readonly benchmark: {
    readonly regime: BenchmarkRegime;
    readonly pnlUsd: number;
    readonly totalReturn: number;
  };
  readonly contextual: EvaluationV2ContextualMetrics;
}

export type EvaluationV2ErrorCode = "INVALID_EVALUATION_V2_INPUT";

export interface EvaluationV2Error {
  readonly code: EvaluationV2ErrorCode;
}

export type EvaluationV2Result = Result<
  EvaluationV2Entry,
  EvaluationV2Error
>;

const finite = (value: number): boolean => Number.isFinite(value);

const nonNegativeFinite = (value: number): boolean =>
  finite(value) && value >= 0;

const winRateInBounds = (value: number | undefined): boolean =>
  value === undefined || (finite(value) && value >= 0 && value <= 1);

/**
 * Régime du benchmark dérivé du rendement total au seuil figé du modèle.
 * Jamais un paramètre d'entrée ni une valeur déclarée.
 */
export const benchmarkRegime = (benchmarkTotalReturn: number): BenchmarkRegime =>
  benchmarkTotalReturn >= BENCHMARK_REGIME_THRESHOLD ? "HAUSSIER" : "BAISSIER";

/**
 * Évaluation v2 d'un scénario (models/backtest-diagnostics.md,
 * « Évaluation v2 ») : métriques primaires absolues, régime du benchmark
 * calculé, excess contextuel rapporté uniquement avec son régime.
 */
export const evaluateV2 = (
  scenarioId: string,
  metrics: EvaluationV2MetricsInput,
  benchmark: EvaluationV2BenchmarkInput,
): EvaluationV2Result => {
  const valid =
    scenarioId.trim().length > 0 &&
    finite(metrics.pnl) &&
    finite(metrics.totalReturn) &&
    finite(metrics.realizedPnl) &&
    finite(metrics.unrealizedPnl) &&
    winRateInBounds(metrics.winRateLiquidative) &&
    nonNegativeFinite(metrics.maxDrawdown) &&
    finite(metrics.sharpe) &&
    nonNegativeFinite(metrics.turnover) &&
    nonNegativeFinite(metrics.fees) &&
    finite(benchmark.pnl) &&
    finite(benchmark.totalReturn);
  if (!valid) {
    return err({ code: "INVALID_EVALUATION_V2_INPUT" });
  }
  const regime = benchmarkRegime(benchmark.totalReturn);
  return ok(
    Object.freeze({
      scenarioId,
      primary: Object.freeze({
        pnlUsd: metrics.pnl,
        totalReturn: metrics.totalReturn,
        realizedPnlUsd: metrics.realizedPnl,
        unrealizedPnlUsd: metrics.unrealizedPnl,
        winRateLiquidative: metrics.winRateLiquidative ?? null,
        maxDrawdown: metrics.maxDrawdown,
        sharpe: metrics.sharpe,
        turnover: metrics.turnover,
        feesUsd: metrics.fees,
      }),
      benchmark: Object.freeze({
        regime,
        pnlUsd: benchmark.pnl,
        totalReturn: benchmark.totalReturn,
      }),
      contextual: Object.freeze({
        excessReturn: metrics.totalReturn - benchmark.totalReturn,
      }),
    }),
  );
};
