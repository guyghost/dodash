import type { PaperTrade } from "./paper-broker.js";

export interface EquityPoint {
  readonly at: number;
  readonly equity: number;
}

export interface BacktestMetrics {
  readonly pnl: number;
  readonly totalReturn: number;
  readonly winRate: number;
  readonly profitFactor: number | null;
  readonly sharpe: number;
  readonly maxDrawdown: number;
}

const standardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
};

export const calculateMetrics = (
  equityCurve: readonly EquityPoint[],
  trades: readonly PaperTrade[],
  initialCapital: number,
): BacktestMetrics => {
  const finalEquity = equityCurve.at(-1)?.equity ?? initialCapital;
  const pnl = finalEquity - initialCapital;
  const totalReturn = initialCapital === 0 ? 0 : pnl / initialCapital;

  const realized = trades
    .map((trade) => trade.realizedPnl)
    .filter((value) => value !== 0);
  const wins = realized.filter((value) => value > 0);
  const losses = realized.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const winRate = realized.length === 0 ? 0 : wins.length / realized.length;
  const profitFactor = grossLoss === 0 ? null : grossProfit / grossLoss;

  const returns: number[] = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = equityCurve[index - 1]?.equity;
    const current = equityCurve[index]?.equity;
    if (previous !== undefined && current !== undefined && previous !== 0) {
      returns.push((current - previous) / previous);
    }
  }
  const deviation = standardDeviation(returns);
  const averageReturn =
    returns.length === 0
      ? 0
      : returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const sharpe = deviation === 0 ? 0 : (averageReturn / deviation) * Math.sqrt(252);

  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak === 0 ? 0 : (peak - point.equity) / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return Object.freeze({
    pnl,
    totalReturn,
    winRate,
    profitFactor,
    sharpe,
    maxDrawdown,
  });
};
