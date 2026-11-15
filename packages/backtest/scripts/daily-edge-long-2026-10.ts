// Edge daily au-delà de l'exposition, historique long — protocole FIGÉ :
// models/daily-edge-long-campaign.md (commit ab4458f, antérieur au premier run).
// LECTURE-SEULE TRADING : analyse uniquement. Un échec est consigné, jamais substitué.
// Exécution : pnpm dlx tsx packages/backtest/scripts/daily-edge-long-2026-10.ts <PRODUIT>
// Artefacts : packages/backtest/.artifacts/studies/daily-edge-long-2026-10/
// Le chargeur (throttle, retry, cache, comblement compté) est repris à
// l'identique du script de la campagne intraday (intraday-edge-2026-10.ts).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createCandle,
  createProductId,
  TIMEFRAME_MILLISECONDS,
  validateCandleSeries,
  type Candle,
  type ProductId,
  type Timeframe,
} from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  createBreakoutStrategy,
  createEmaCrossStrategy,
  createRsiReversionStrategy,
  createStrategyRegistry,
  type Strategy,
} from "@dodash/strategies";

import { withConfidenceCalibration } from "../src/confidence-calibrated-strategy.js";
import { prepareBacktestIndicators } from "../src/prepared-indicators.js";
import { replayBacktest } from "../src/replay.js";
import { withTargetSignalNotional } from "../src/target-notional-strategy.js";

const PROTOCOL_REF = "models/daily-edge-long-campaign.md (commit ab4458f)";
const OUTPUT_DIR = "packages/backtest/.artifacts/studies/daily-edge-long-2026-10";
const CACHE_DIR = "packages/backtest/.artifacts/cache/coinbase-candles";
const BASE_URL = "https://api.coinbase.com";

const WINDOWS: Readonly<Record<string, { startAt: number; endAt: number }>> = Object.freeze({
  "BTC-USD": { startAt: Date.parse("2015-07-21T00:00:00Z"), endAt: Date.parse("2026-10-01T00:00:00Z") },
  "ETH-USD": { startAt: Date.parse("2016-05-19T00:00:00Z"), endAt: Date.parse("2026-10-01T00:00:00Z") },
});
const SLIPPAGE_BPS = 2;
const FEE_ARMS = Object.freeze([
  { id: "M40", feeBps: 40 },
  { id: "T60", feeBps: 60 },
  { id: "T120", feeBps: 120 },
]);
const MAX_FILL_RATE = 0.005;
const INITIAL_CAPITAL = 10_000;
const TARGET_SIGNAL_NOTIONAL = 1_000;
const RISK = Object.freeze({
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
});

const size = (strategy: Strategy): Strategy =>
  withTargetSignalNotional(strategy, TARGET_SIGNAL_NOTIONAL);
const SCENARIOS = Object.freeze([
  { id: "rsi-reversion", build: () => [size(createRsiReversionStrategy({ oversold: 30, overbought: 70, baseSize: TARGET_SIGNAL_NOTIONAL }))] },
  { id: "ema-cross:POWER_THIRD", build: () => [size(withConfidenceCalibration(createEmaCrossStrategy({ baseSize: TARGET_SIGNAL_NOTIONAL }), "POWER_THIRD"))] },
  { id: "breakout:POWER_THIRD", build: () => [size(withConfidenceCalibration(createBreakoutStrategy({ lookback: 20, baseSize: TARGET_SIGNAL_NOTIONAL }), "POWER_THIRD"))] },
] as const);

// ─── Données : throttle, retry, cache, comblement compté (§2.7) ─────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequestAt = 0;

const fetchPage = async (url: URL): Promise<unknown> => {
  const key = createHash("sha256").update(url.href).digest("hex");
  const path = `${CACHE_DIR}/${key}.json`;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // absent du cache
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = lastRequestAt + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as unknown;
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(path, JSON.stringify(body), "utf8");
      return body;
    }
    const status = response?.status ?? 0;
    await response?.body?.cancel().catch(() => undefined);
    if (status !== 0 && status !== 429 && status < 500) {
      throw new Error(`HTTP ${status} ${url.href}`);
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error(`échec après 5 essais ${url.href}`);
};

interface LoadedDataset {
  readonly candles: readonly Candle[];
  readonly sha256: string;
  readonly filled: number;
  readonly expected: number;
}

const loadDataset = async (
  productId: ProductId,
  timeframe: Timeframe,
  startAt: number,
  endAt: number,
): Promise<LoadedDataset> => {
  const duration = TIMEFRAME_MILLISECONDS[timeframe];
  const endpoint = `${BASE_URL}/api/v3/brokerage/market/products/${productId}/candles`;
  const byStart = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();
  const PAGE = 350;
  for (let pageStart = startAt; pageStart < endAt; pageStart += PAGE * duration) {
    const pageEnd = Math.min(endAt, pageStart + PAGE * duration);
    const url = new URL(endpoint);
    // L'API renvoie les bougies dont le début est dans [start, end) ; même
    // bornage que coinbase-history.ts (décalage d'une bougie).
    url.searchParams.set("start", String((pageStart - duration) / 1_000));
    url.searchParams.set("end", String((pageEnd - duration) / 1_000));
    url.searchParams.set("granularity", timeframe);
    url.searchParams.set("limit", String((pageEnd - pageStart) / duration));
    const body = (await fetchPage(url)) as { candles?: readonly Record<string, string>[] };
    for (const raw of body.candles ?? []) {
      const at = Number(raw.start) * 1_000;
      if (at < startAt || at >= endAt) continue;
      byStart.set(at, {
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        volume: Number(raw.volume),
      });
    }
  }
  const expected = (endAt - startAt) / duration;
  const candles: Candle[] = [];
  let filled = 0;
  let previousClose: number | null = null;
  for (let at = startAt; at < endAt; at += duration) {
    let raw = byStart.get(at);
    if (raw === undefined) {
      if (previousClose === null) {
        // Bougie initiale manquante : prendre l'ouverture de la première présente.
        const next = [...byStart.keys()].filter((k) => k > at).sort((a, b) => a - b)[0];
        const seed = next === undefined ? undefined : byStart.get(next);
        if (seed === undefined) throw new Error("dataset vide");
        previousClose = seed.open;
      }
      raw = { open: previousClose, high: previousClose, low: previousClose, close: previousClose, volume: 0 };
      filled += 1;
    }
    const candle = createCandle({ start: at, ...raw });
    if (!candle.ok) throw new Error(`bougie invalide ${at}`);
    candles.push(candle.value);
    previousClose = raw.close;
  }
  const validated = validateCandleSeries(candles);
  if (!validated.ok) throw new Error("série invalide");
  const sha256 = createHash("sha256")
    .update(JSON.stringify({ source: "coinbase", endpoint, productId, timeframe, startAt, endAt, candles: validated.value }))
    .digest("hex");
  return { candles: validated.value, sha256, filled, expected };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
};

const main = async (): Promise<void> => {
  const product = createProductId(process.argv[2] ?? "");
  if (!product.ok) throw new Error("produit invalide");
  const window = WINDOWS[product.value];
  if (window === undefined) throw new Error("produit hors grille");
  const timeframe: Timeframe = "ONE_DAY";
  const outPath = `${OUTPUT_DIR}/job--${product.value}.json`;
  const base = { protocol: PROTOCOL_REF, product: product.value, timeframe, ...window };
  const dataset = await loadDataset(product.value, timeframe, window.startAt, window.endAt);
  const fillRate = dataset.filled / dataset.expected;
  const datasetInfo = { sha256: dataset.sha256, candles: dataset.candles.length, filled: dataset.filled, fillRate };
  console.error(`[${product.value}] dataset ${dataset.candles.length} bougies, comblées ${dataset.filled}`);
  if (fillRate > MAX_FILL_RATE) {
    await writeJson(outPath, { ...base, status: "NON_EXECUTABLE", raison: `comblement ${fillRate}`, dataset: datasetInfo, runs: [] });
    return;
  }
  const prepared = await prepareBacktestIndicators(dataset.candles, DEFAULT_INDICATOR_CONFIG);
  if (!prepared.ok) {
    await writeJson(outPath, { ...base, status: "ECHEC", raison: prepared.error.code, dataset: datasetInfo, runs: [] });
    return;
  }
  console.error(`[${product.value}] indicateurs préparés`);
  const runs: unknown[] = [];
  for (const scenario of SCENARIOS) {
    for (const arm of FEE_ARMS) {
      const registry = createStrategyRegistry(scenario.build());
      if (!registry.ok) throw new Error("registre invalide");
      const replay = await replayBacktest(
        dataset.candles,
        {
          intervalMs: TIMEFRAME_MILLISECONDS[timeframe],
          runId: `daily-edge-long-2026-10:${product.value}:${scenario.id}:${arm.id}`,
          agentId: "dodash-backtest",
          productId: product.value,
          initialCapital: INITIAL_CAPITAL,
          maxDecisionNotional: 2_000,
          minNetQuantity: 0.000_001,
          indicators: DEFAULT_INDICATOR_CONFIG,
          strategies: registry.value,
          risk: RISK,
          broker: { feeBps: arm.feeBps, slippageBps: SLIPPAGE_BPS },
        },
        prepared.value,
      );
      if (!replay.ok) {
        runs.push({ scenario: scenario.id, arm: arm.id, status: "ECHEC", raison: replay.error.code });
        continue;
      }
      runs.push({
        scenario: scenario.id,
        arm: arm.id,
        feeBps: arm.feeBps,
        status: "OK",
        metrics: replay.value.metrics,
        equity: replay.value.equityCurve.map((point) => [point.at, point.equity]),
        trades: replay.value.trades.map((trade) => ({
          executedAt: trade.fill.executedAt,
          price: trade.fill.price,
          quantity: trade.fill.quantity,
          fee: trade.fill.fee,
          closedQuantity: trade.closedQuantity,
          realizedPnl: trade.realizedPnl,
        })),
      });
    }
    console.error(`[${product.value}] ${scenario.id} rejoué`);
  }
  await writeJson(outPath, {
    ...base,
    status: "OK",
    dataset: datasetInfo,
    candles: dataset.candles.map((candle) => [candle.start, candle.open, candle.close]),
    runs,
  });
  console.error(`[${product.value}] terminé`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
