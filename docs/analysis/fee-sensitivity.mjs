// Script d'analyse (mission 4 du brief ANALYSE-BACKTEST-BRIEF.md) — non
// commité, aucune modification de code métier. Rejoue la suite standard du
// dépôt (mêmes défauts que src/cli.ts) avec frais ×1 (témoin), ×1,5 et ×2.
// Données : fetch Coinbase réel, fenêtre fixtures dao30 (365 j).
import { loadCoinbaseHistoricalDataset, runBacktestSuite } from "./packages/backtest/dist/index.js";
import { DEFAULT_INDICATOR_CONFIG } from "./packages/indicators-prolog/dist/index.js";

const productId = "BTC-USD";
const startAt = Date.parse("2025-09-01T00:00:00Z");
const endAt = Date.parse("2026-09-01T00:00:00Z");

const base = {
  runId: "analysis-fee-sensitivity",
  agentId: "dodash-backtest",
  initialCapital: 10_000,
  maxDecisionNotional: 2_000,
  minNetQuantity: 0.000_001,
  targetSignalNotional: 1_000,
  indicators: DEFAULT_INDICATOR_CONFIG,
  risk: Object.freeze({
    maxOrderNotional: 2_000,
    maxPositionNotional: 10_000,
    maxGrossExposure: 20_000,
    maxDailyLoss: 1_000,
    cooldownMs: 0,
    stopLossBps: 150,
    takeProfitBps: 300,
  }),
};

console.log("Chargement dataset Coinbase…");
const dataset = await loadCoinbaseHistoricalDataset({ productId, timeframe: "ONE_DAY", startAt, endAt });
if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));
console.log(`Dataset OK: ${dataset.value.datasetId} (${dataset.value.candles.length} bougies)`);

const arms = [
  { label: "x1.0 (temoin cli)", broker: Object.freeze({ feeBps: 6, slippageBps: 2 }) },
  { label: "x1.5", broker: Object.freeze({ feeBps: 9, slippageBps: 3 }) },
  { label: "x2.0", broker: Object.freeze({ feeBps: 12, slippageBps: 4 }) },
];

const report = { datasetId: dataset.value.datasetId, candles: dataset.value.candles.length, arms: [] };
for (const arm of arms) {
  console.log(`Run broker ${JSON.stringify(arm.broker)} (${arm.label})…`);
  const result = await runBacktestSuite(dataset.value, Object.freeze({ ...base, broker: arm.broker }));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  report.arms.push({
    label: arm.label,
    broker: arm.broker,
    benchmark: result.value.benchmark,
    scenarios: result.value.scenarios.map((s) => ({
      id: s.id,
      tradeCount: s.tradeCount,
      pnl: s.metrics.pnl,
      realizedPnl: s.metrics.realizedPnl,
      unrealizedPnl: s.metrics.unrealizedPnl,
      fees: s.metrics.fees,
      totalReturn: s.metrics.totalReturn,
      winRate: s.metrics.winRate,
      winRateLiquidative: s.metrics.winRateLiquidative,
      profitFactor: s.metrics.profitFactor,
      sharpe: s.metrics.sharpe,
      maxDrawdown: s.metrics.maxDrawdown,
      excessReturn: s.excessReturn,
    })),
  });
  for (const s of report.arms.at(-1).scenarios) {
    console.log(`  ${arm.label} ${s.id}: pnl=${s.pnl.toFixed(2)} ret=${(s.totalReturn * 100).toFixed(2)}% sharpe=${s.sharpe.toFixed(3)} dd=${(s.maxDrawdown * 100).toFixed(2)}% trades=${s.tradeCount} fees=${s.fees.toFixed(2)}`);
  }
}

const { writeFile } = await import("node:fs/promises");
await writeFile("/tmp/dao-analysis/fee-sensitivity.json", JSON.stringify(report, null, 2));
console.log("Écrit: /tmp/dao-analysis/fee-sensitivity.json");
