import type { PaperTrade } from "./paper-broker.js";

export interface EquityPoint {
  readonly at: number;
  readonly equity: number;
}

export interface BacktestMetrics {
  readonly pnl: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly fees: number;
  readonly grossTradedNotional: number;
  readonly turnover: number;
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

  const closedTrades = trades.filter((trade) => trade.closedQuantity > 0);
  const realized = closedTrades.map((trade) => trade.realizedPnl);
  const wins = realized.filter((value) => value > 0);
  const losses = realized.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const winRate = closedTrades.length === 0 ? 0 : wins.length / closedTrades.length;
  const profitFactor = grossLoss === 0 ? null : grossProfit / grossLoss;
  const realizedPnl = realized.reduce((sum, value) => sum + value, 0);
  const unrealizedPnl = pnl - realizedPnl;
  const fees = trades.reduce((sum, trade) => sum + trade.fill.fee, 0);
  const grossTradedNotional = trades.reduce(
    (sum, trade) => sum + Math.abs(trade.fill.price * trade.fill.quantity),
    0,
  );
  const turnover = initialCapital === 0 ? 0 : grossTradedNotional / initialCapital;

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
    realizedPnl,
    unrealizedPnl,
    fees,
    grossTradedNotional,
    turnover,
    totalReturn,
    winRate,
    profitFactor,
    sharpe,
    maxDrawdown,
  });
};
