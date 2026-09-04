// DAO #40 — Campagne d'edge multi-régimes (grille v2).
// MODÈLE : models/edge-research-campaign.md — grille FIGÉE avant exécution
// (commit models 168fa80 strictement antérieur au premier run, C1).
// LECTURE-SEULE TRADING (C2) : ce script n'ajoute que de l'analyse ; aucune
// stratégie, machine ou permission n'est modifiée ; aucune activation.
// CHIFFRES RÉELS (C3) : sorties des outils du dépôt uniquement ; un échec de
// cellule est consigné (statut ECHEC + raison), jamais substitué.
// Reprise : un artefact de run existant est rechargé, pas rejoué (seule
// l'horodatage diffère) — aucune valeur n'est réécrite.
// Exécution : pnpm dlx tsx packages/backtest/scripts/edge-research-grid.ts
// Artefacts : packages/backtest/.artifacts/studies/edge-grid-2026-09/

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createProductId, type Candle, type ProductId, type Timeframe } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  FUNDING_TREND_ENTER_THRESHOLD,
  type ConfidenceCalibrationProfile,
} from "@dodash/models";
import {
  createFundingTrendStrategy,
  createStrategyRegistry,
  withTargetSignalNotional,
} from "@dodash/strategies";

import { loadCoinbaseHistoricalDataset } from "../src/coinbase-history.js";
import { evaluateV2 } from "../src/evaluation-v2.js";
import { replayBacktest, type BacktestConfig } from "../src/replay.js";
import {
  runBacktestSuite,
  type BacktestSuiteConfig,
  type BacktestSuiteReport,
} from "../src/suite.js";

type SuiteReport = BacktestSuiteReport;
type SuiteScenario = BacktestSuiteReport["scenarios"][number];

// ─── Grille figée (models/edge-research-campaign.md §3) ─────────────────────

const GRID_REF = "models/edge-research-campaign.md (commit 168fa80)";
const OUTPUT_DIR = "packages/backtest/.artifacts/studies/edge-grid-2026-09";

const ASSETS = ["BTC-USD", "ETH-USD"] as const;
type Asset = (typeof ASSETS)[number];

interface FrozenWindow {
  readonly id: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly expectedCandles: number;
}

// Bornes UTC, borne de fin exclusive ; dernier jour clôturé 2026-09-03.
const WINDOWS: readonly FrozenWindow[] = Object.freeze([
  { id: "FULL", startAt: Date.parse("2021-01-01T00:00:00Z"), endAt: Date.parse("2026-09-04T00:00:00Z"), expectedCandles: 2_072 },
  { id: "Y2021", startAt: Date.parse("2021-01-01T00:00:00Z"), endAt: Date.parse("2022-01-01T00:00:00Z"), expectedCandles: 365 },
  { id: "Y2022", startAt: Date.parse("2022-01-01T00:00:00Z"), endAt: Date.parse("2023-01-01T00:00:00Z"), expectedCandles: 365 },
  { id: "Y2023", startAt: Date.parse("2023-01-01T00:00:00Z"), endAt: Date.parse("2024-01-01T00:00:00Z"), expectedCandles: 365 },
  { id: "Y2024", startAt: Date.parse("2024-01-01T00:00:00Z"), endAt: Date.parse("2025-01-01T00:00:00Z"), expectedCandles: 366 },
  { id: "Y2025", startAt: Date.parse("2025-01-01T00:00:00Z"), endAt: Date.parse("2026-01-01T00:00:00Z"), expectedCandles: 365 },
  { id: "Y2026", startAt: Date.parse("2026-01-01T00:00:00Z"), endAt: Date.parse("2026-09-04T00:00:00Z"), expectedCandles: 246 },
]);

const CALIBRATIONS = ["IDENTITY", "POWER_THIRD"] as const satisfies readonly ConfidenceCalibrationProfile[];
type Calibration = (typeof CALIBRATIONS)[number];

const COST_ARMS = Object.freeze([
  { id: "x1", feeBps: 6, slippageBps: 2 },
  { id: "x2", feeBps: 12, slippageBps: 4 },
]);
type CostArm = (typeof COST_ARMS)[number];

const PRIMARY_STRATEGIES = ["rsi-reversion", "ema-cross", "breakout"] as const;
type PrimaryStrategy = (typeof PRIMARY_STRATEGIES)[number];

// Verdicts (fonction figée, models §4) — dans cet ordre.
const INACTIVITY_MEDIAN_NOTIONAL_USD = 100;
type Verdict = "EDGE_DEMONTRE" | "NON_DEMONTRE" | "INACTIF";

const verdictFor = (
  tradeCount: number,
  medianRequestedNotionalUsd: number | null,
  pnl: number,
  sharpe: number,
): Verdict => {
  if (
    tradeCount === 0 ||
    medianRequestedNotionalUsd === null ||
    medianRequestedNotionalUsd < INACTIVITY_MEDIAN_NOTIONAL_USD
  ) {
    return "INACTIF";
  }
  if (pnl > 0 && sharpe > 0) return "EDGE_DEMONTRE";
  return "NON_DEMONTRE";
};

// Déduplication pré-déclarée (models §9, INV-8) : rsi-reversion est
// invariante par calibration.
const candidateKeyFor = (
  strategy: PrimaryStrategy,
  asset: Asset,
  window: FrozenWindow,
  calibration: Calibration,
  cost: CostArm,
): string =>
  strategy === "rsi-reversion"
    ? `${strategy}|${asset}|${window.id}|${cost.id}`
    : `${strategy}|${asset}|${window.id}|${calibration}|${cost.id}`;

// ─── Config commune (models §3.6, défauts du CLI) ───────────────────────────

const INITIAL_CAPITAL = 10_000;
const TARGET_SIGNAL_NOTIONAL = 1_000;
const AGENT_ID = "dodash-backtest";
const RISK = Object.freeze({
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
});

const suiteConfigFor = (
  runId: string,
  calibration: Calibration,
  cost: CostArm,
): BacktestSuiteConfig =>
  Object.freeze({
    runId,
    agentId: AGENT_ID,
    initialCapital: INITIAL_CAPITAL,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
    confidenceCalibration: calibration,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: RISK,
    broker: Object.freeze({ feeBps: cost.feeBps, slippageBps: cost.slippageBps }),
  });

// ─── Artefacts ──────────────────────────────────────────────────────────────

interface CellRow {
  readonly asset: Asset;
  readonly window: string;
  readonly calibration: Calibration | null;
  readonly cost: string;
  readonly strategy: string;
  readonly role: "primaire" | "informationnel";
  readonly status: "OK" | "ECHEC";
  readonly raison: string | null;
  readonly datasetId: string | null;
  readonly trades: number | null;
  readonly pnlUsd: number | null;
  readonly totalReturn: number | null;
  readonly realizedPnlUsd: number | null;
  readonly unrealizedPnlUsd: number | null;
  readonly winRateLiquidative: number | null;
  readonly maxDrawdown: number | null;
  readonly sharpe: number | null;
  readonly turnover: number | null;
  readonly feesUsd: number | null;
  readonly benchmarkPnlUsd: number | null;
  readonly benchmarkTotalReturn: number | null;
  readonly regime: string | null;
  readonly excessReturn: number | null;
  readonly medianRequestedNotionalUsd: number | null;
  readonly verdict: Verdict | null;
  readonly candidateKey: string | null;
  readonly durationMs: number | null;
}

interface RunRecord {
  readonly runId: string;
  readonly asset: Asset;
  readonly window: string;
  readonly calibration: Calibration;
  readonly cost: string;
  readonly status: "OK" | "ECHEC";
  readonly raison: string | null;
  readonly datasetId: string | null;
  readonly durationMs: number;
  readonly cells: readonly CellRow[];
}

const runArtifactPath = (parts: readonly string[]): string =>
  `${OUTPUT_DIR}/run--${parts.join("--")}.json`;

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJsonOrNull = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
};

// ─── Exécution d'un run de suite (4 scénarios) ──────────────────────────────

const medianRequestedNotionalOf = (
  scenario: SuiteScenario,
  strategyId: string,
): number | null =>
  scenario.diagnostics.signals.byStrategy.find(
    (signal) => signal.strategyId === strategyId,
  )?.requestedNotional.median ?? null;

const cellsFromRun = (
  asset: Asset,
  window: FrozenWindow,
  calibration: Calibration,
  cost: CostArm,
  datasetId: string,
  durationMs: number,
  run: SuiteReport,
): readonly CellRow[] =>
  run.scenarios.map((scenario) => {
    const isPrimary = (PRIMARY_STRATEGIES as readonly string[]).includes(scenario.id);
    const evaluation = evaluateV2(`${run.runId}:${scenario.id}`, {
      pnl: scenario.metrics.pnl,
      totalReturn: scenario.metrics.totalReturn,
      realizedPnl: scenario.metrics.realizedPnl,
      unrealizedPnl: scenario.metrics.unrealizedPnl,
      winRateLiquidative: scenario.metrics.winRateLiquidative,
      maxDrawdown: scenario.metrics.maxDrawdown,
      sharpe: scenario.metrics.sharpe,
      turnover: scenario.metrics.turnover,
      fees: scenario.metrics.fees,
    }, {
      pnl: run.benchmark.pnl,
      totalReturn: run.benchmark.totalReturn,
    });
    if (!evaluation.ok) {
      return {
        asset,
        window: window.id,
        calibration: isPrimary ? calibration : null,
        cost: cost.id,
        strategy: scenario.id,
        role: isPrimary ? "primaire" : "informationnel",
        status: "ECHEC",
        raison: `evaluation-v2: ${evaluation.error.code}`,
        datasetId,
        trades: scenario.tradeCount,
        pnlUsd: null,
        totalReturn: null,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
        winRateLiquidative: null,
        maxDrawdown: null,
        sharpe: null,
        turnover: null,
        feesUsd: null,
        benchmarkPnlUsd: run.benchmark.pnl,
        benchmarkTotalReturn: run.benchmark.totalReturn,
        regime: null,
        excessReturn: null,
        medianRequestedNotionalUsd: null,
        verdict: null,
        candidateKey: null,
        durationMs,
      } satisfies CellRow;
    }
    const median =
      isPrimary || scenario.id === "ensemble"
        ? medianRequestedNotionalOf(scenario, scenario.id)
        : null;
    const verdict = isPrimary
      ? verdictFor(scenario.tradeCount, median, scenario.metrics.pnl, scenario.metrics.sharpe)
      : null;
    return {
      asset,
      window: window.id,
      calibration: isPrimary ? calibration : null,
      cost: cost.id,
      strategy: scenario.id,
      role: isPrimary ? "primaire" : "informationnel",
      status: "OK",
      raison: null,
      datasetId,
      trades: scenario.tradeCount,
      pnlUsd: evaluation.value.primary.pnlUsd,
      totalReturn: evaluation.value.primary.totalReturn,
      realizedPnlUsd: evaluation.value.primary.realizedPnlUsd,
      unrealizedPnlUsd: evaluation.value.primary.unrealizedPnlUsd,
      winRateLiquidative: evaluation.value.primary.winRateLiquidative,
      maxDrawdown: evaluation.value.primary.maxDrawdown,
      sharpe: evaluation.value.primary.sharpe,
      turnover: evaluation.value.primary.turnover,
      feesUsd: evaluation.value.primary.feesUsd,
      benchmarkPnlUsd: evaluation.value.benchmark.pnlUsd,
      benchmarkTotalReturn: evaluation.value.benchmark.totalReturn,
      regime: evaluation.value.benchmark.regime,
      excessReturn: evaluation.value.contextual.excessReturn,
      medianRequestedNotionalUsd: median,
      verdict,
      candidateKey: isPrimary
        ? candidateKeyFor(scenario.id as PrimaryStrategy, asset, window, calibration, cost)
        : null,
      durationMs,
    } satisfies CellRow;
  });

type Dataset = Extract<
  Awaited<ReturnType<typeof loadCoinbaseHistoricalDataset>>,
  { readonly ok: true }
>["value"];

const runOne = async (
  asset: Asset,
  productId: ProductId,
  dataset: Dataset,
  window: FrozenWindow,
  calibration: Calibration,
  cost: CostArm,
): Promise<RunRecord> => {
  const runId = `edge-grid-2026-09:${productId}:${window.id}:${calibration}:${cost.id}`;
  const startedAt = Date.now();
  const run = await runBacktestSuite(
    dataset,
    suiteConfigFor(runId, calibration, cost),
  );
  const durationMs = Date.now() - startedAt;
  if (!run.ok) {
    return {
      runId,
      asset,
      window: window.id,
      calibration,
      cost: cost.id,
      status: "ECHEC",
      raison: `suite: ${run.error.code}`,
      datasetId: dataset.datasetId,
      durationMs,
      cells: [],
    };
  }
  return {
    runId,
    asset,
    window: window.id,
    calibration,
    cost: cost.id,
    status: "OK",
    raison: null,
    datasetId: dataset.datasetId,
    durationMs,
    cells: cellsFromRun(productId as Asset, window, calibration, cost, dataset.datasetId, durationMs, run.value),
  };
};

// ─── Cellule informationnelle funding-trend p75 (models §3.5) ───────────────

interface FixtureProvenance {
  readonly sha256: string;
}

const loadFixture = async <T>(
  dataPath: string,
  provenancePath: string,
): Promise<T> => {
  const bytes = await readFile(dataPath);
  const provenance = JSON.parse(
    await readFile(provenancePath, "utf8"),
  ) as FixtureProvenance;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 !== provenance.sha256) {
    throw new Error(`empreinte fixture invalide: ${dataPath}`);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
};

const DAY = 86_400_000;

// Convention #27 : moyenne des taux observés dans [start, start + 24 h) de
// chaque bougie ; une bougie sans observation est une erreur.
const dailyRatesForCandles = (
  candles: readonly Candle[],
  samples: readonly { readonly time: number; readonly fundingRate: number }[],
): readonly number[] => {
  const rates: number[] = [];
  let cursor = 0;
  for (const candle of candles) {
    const end = candle.start + DAY;
    let sum = 0;
    let count = 0;
    while (cursor < samples.length) {
      const sample = samples[cursor];
      if (sample === undefined || sample.time >= end) break;
      if (sample.time >= candle.start) {
        sum += sample.fundingRate;
        count += 1;
      }
      cursor += 1;
    }
    if (count === 0) {
      throw new Error(`bougie ${candle.start} sans observation funding`);
    }
    rates.push(sum / count);
  }
  return rates;
};

const FUNDING_TREND_WARMUP_PREFIX_DAYS = 90;

const fundingTrendCell = async (
  productId: ProductId,
): Promise<CellRow> => {
  const startedAt = Date.now();
  // C3 : la constante figée du modèle est re-vérifiée contre l'annexe #35.
  const annex = JSON.parse(
    await readFile(
      "models/funding-edge-campaign-v2.annexe-calibration.json",
      "utf8",
    ),
  ) as { readonly distributionAbsFundingAvg: { readonly p75: number } };
  if (FUNDING_TREND_ENTER_THRESHOLD !== annex.distributionAbsFundingAvg.p75) {
    throw new Error("constante FUNDING_TREND_ENTER_THRESHOLD != annexe p75");
  }
  const funding30 = await loadFixture<{
    readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
  }>(
    "packages/backtest/fixtures/dao30-funding-btc.json",
    "packages/backtest/fixtures/dao30-funding-btc.provenance.json",
  );
  const price30 = await loadFixture<{ readonly candles: readonly Candle[] }>(
    "packages/backtest/fixtures/dao30-price-btc-usd.json",
    "packages/backtest/fixtures/dao30-price-btc-usd.provenance.json",
  );
  const funding35 = await loadFixture<{
    readonly samples: readonly { readonly time: number; readonly fundingRate: number }[];
  }>(
    "packages/backtest/fixtures/dao35-funding-btc-oos.json",
    "packages/backtest/fixtures/dao35-funding-btc-oos.provenance.json",
  );
  const price35 = await loadFixture<{ readonly candles: readonly Candle[] }>(
    "packages/backtest/fixtures/dao35-price-btc-usd-oos.json",
    "packages/backtest/fixtures/dao35-price-btc-usd-oos.provenance.json",
  );

  // Continuation dao35 : préfixe 90 bougies campagne-1 + OOS, contiguïté
  // exigée (miroir protocole #35 §4.3).
  const prefix = price30.candles.slice(-FUNDING_TREND_WARMUP_PREFIX_DAYS);
  const firstOos = price35.candles[0];
  const lastPrefix = prefix.at(-1);
  if (
    firstOos === undefined ||
    lastPrefix === undefined ||
    firstOos.start !== lastPrefix.start + DAY
  ) {
    throw new Error("fenêtre OOS dao35 non contiguë au préfixe campagne-1");
  }
  const continuationCandles = [...prefix, ...price35.candles];
  const continuationRates = dailyRatesForCandles(
    continuationCandles,
    [...funding30.samples, ...funding35.samples],
  );

  // Chemin de repli SANS indicateurs préparés : les snapshots préparés (#37)
  // ne portent pas fundingAvg — un 0 trade obtenu par ce chemin serait un
  // artefact de mécanique (models/edge-research-campaign.md §3.5).
  const strategy = withTargetSignalNotional(
    createFundingTrendStrategy({ baseSize: TARGET_SIGNAL_NOTIONAL }),
    TARGET_SIGNAL_NOTIONAL,
  );
  const registry = createStrategyRegistry([strategy]);
  if (!registry.ok) throw new Error("registre funding-trend invalide");
  const config: BacktestConfig = Object.freeze({
    intervalMs: 86_400_000,
    runId: `edge-grid-2026-09:funding-trend-p75:${productId}`,
    agentId: AGENT_ID,
    productId,
    initialCapital: INITIAL_CAPITAL,
    maxDecisionNotional: 2_000,
    minNetQuantity: 1e-6,
    indicators: DEFAULT_INDICATOR_CONFIG,
    strategies: registry.value,
    risk: RISK,
    broker: Object.freeze({ feeBps: 6, slippageBps: 2 }),
    fundingRates: continuationRates,
  });
  const run = await replayBacktest(continuationCandles, config);
  if (!run.ok) throw new Error(`replay funding-trend: ${run.error.code}`);
  const durationMs = Date.now() - startedAt;
  const metrics = run.value.metrics;
  return {
    asset: "BTC-USD",
    window: `funding-trend-p75-dao35-continuation(prefixe${FUNDING_TREND_WARMUP_PREFIX_DAYS}+oos3j)`,
    calibration: null,
    cost: "x1",
    strategy: "funding-trend",
    role: "informationnel",
    status: "OK",
    raison: null,
    datasetId: `fixtures:dao30+dao35:p75=${FUNDING_TREND_ENTER_THRESHOLD}`,
    trades: run.value.trades.length,
    // 0 trade attendu (constat §5 du modèle funding-rate-strategy) ; le
    // comptage total couvre la vérification informationnelle.
    pnlUsd: metrics.pnl,
    totalReturn: metrics.totalReturn,
    realizedPnlUsd: metrics.realizedPnl,
    unrealizedPnlUsd: metrics.unrealizedPnl,
    winRateLiquidative: metrics.winRateLiquidative,
    maxDrawdown: metrics.maxDrawdown,
    sharpe: metrics.sharpe,
    turnover: metrics.turnover,
    feesUsd: metrics.fees,
    benchmarkPnlUsd: null,
    benchmarkTotalReturn: null,
    regime: null,
    excessReturn: null,
    medianRequestedNotionalUsd: null,
    verdict: null,
    candidateKey: null,
    durationMs,
  };
};

// ─── Boucle principale ──────────────────────────────────────────────────────

const productId = (asset: Asset): ProductId => {
  const created = createProductId(asset);
  if (!created.ok) throw new Error(`produit invalide: ${asset}`);
  return created.value;
};

const main = async (): Promise<void> => {
  const startedAt = Date.now();
  const runs: RunRecord[] = [];
  const fundingCells: CellRow[] = [];

  for (const asset of ASSETS) {
    const product = productId(asset);
    for (const window of WINDOWS) {
      // Un dataset par (actif, fenêtre), partagé entre les 4 bras
      // (models §7) ; fetché une fois, empreinte SHA-256 consignée.
      let dataset: Dataset | null = null;
      let datasetFailure: string | null = null;
      const datasetStartedAt = Date.now();
      const loaded = await loadCoinbaseHistoricalDataset({
        productId: product,
        timeframe: "ONE_DAY" as Timeframe,
        startAt: window.startAt,
        endAt: window.endAt,
      });
      if (loaded.ok) {
        if (loaded.value.candles.length !== window.expectedCandles) {
          datasetFailure = `bougies attendues ${window.expectedCandles}, obtenues ${loaded.value.candles.length}`;
        } else {
          dataset = loaded.value;
        }
      } else {
        datasetFailure = `dataset: ${loaded.error.code}${loaded.error.code === "HISTORICAL_UPSTREAM_ERROR" ? ` (status ${loaded.error.status})` : ""}`;
      }
      const datasetDurationMs = Date.now() - datasetStartedAt;

      for (const calibration of CALIBRATIONS) {
        for (const cost of COST_ARMS) {
          const artifactPath = runArtifactPath([asset, window.id, calibration, cost.id]);
          const cached = await readJsonOrNull<RunRecord>(artifactPath);
          if (cached !== null) {
            runs.push(cached);
            console.log(
              `[reprise] ${asset} ${window.id} ${calibration} ${cost.id} — artefact existant rechargé (${cached.status})`,
            );
            continue;
          }
          if (dataset === null) {
            // Cellules non exécutables : consignées avec la raison (C3),
            // jamais retirées de la grille ni substituées.
            const failed: RunRecord = {
              runId: `edge-grid-2026-09:${asset}:${window.id}:${calibration}:${cost.id}`,
              asset,
              window: window.id,
              calibration,
              cost: cost.id,
              status: "ECHEC",
              raison: datasetFailure ?? "dataset indisponible",
              datasetId: null,
              durationMs: datasetDurationMs,
              cells: PRIMARY_STRATEGIES.map((strategy) => ({
                asset,
                window: window.id,
                calibration,
                cost: cost.id,
                strategy,
                role: "primaire",
                status: "ECHEC",
                raison: datasetFailure ?? "dataset indisponible",
                datasetId: null,
                trades: null,
                pnlUsd: null,
                totalReturn: null,
                realizedPnlUsd: null,
                unrealizedPnlUsd: null,
                winRateLiquidative: null,
                maxDrawdown: null,
                sharpe: null,
                turnover: null,
                feesUsd: null,
                benchmarkPnlUsd: null,
                benchmarkTotalReturn: null,
                regime: null,
                excessReturn: null,
                medianRequestedNotionalUsd: null,
                verdict: null,
                candidateKey: null,
                durationMs: datasetDurationMs,
              })),
            };
            runs.push(failed);
            await writeJson(artifactPath, failed);
            console.error(
              `[ECHEC] ${asset} ${window.id} ${calibration} ${cost.id} — ${failed.raison}`,
            );
            continue;
          }
          const record = await runOne(asset, product, dataset, window, calibration, cost);
          runs.push(record);
          await writeJson(artifactPath, record);
          const primaryCells = record.cells.filter(
            (cell) => cell.role === "primaire",
          );
          console.log(
            `[run] ${asset} ${window.id} ${calibration} ${cost.id} — ${record.status} en ${(record.durationMs / 1_000).toFixed(1)}s | ${primaryCells
              .map((cell) => `${cell.strategy}=${cell.status === "OK" ? `${(cell.pnlUsd ?? 0).toFixed(2)}$ ${cell.verdict}` : "ECHEC"}`)
              .join(" | ")}`,
          );
        }
      }
    }
  }

  // Cellule informationnelle funding-trend p75 (reprise incluse).
  const fundingPath = `${OUTPUT_DIR}/funding-trend-p75.json`;
  const cachedFunding = await readJsonOrNull<CellRow>(fundingPath);
  if (cachedFunding !== null) {
    fundingCells.push(cachedFunding);
    console.log("[reprise] funding-trend p75 — artefact existant rechargé");
  } else {
    try {
      const cell = await fundingTrendCell(productId("BTC-USD"));
      fundingCells.push(cell);
      await writeJson(fundingPath, cell);
      console.log(
        `[run] funding-trend p75 — OK en ${(cell.durationMs / 1_000).toFixed(1)}s | trades=${cell.trades} pnl=${(cell.pnlUsd ?? 0).toFixed(2)}$ (0 trade attendu, informationnel)`,
      );
    } catch (error: unknown) {
      const raison = error instanceof Error ? error.message : "ERREUR_INCONNUE";
      const failed: CellRow = {
        asset: "BTC-USD",
        window: "funding-trend-p75-dao35-continuation",
        calibration: null,
        cost: "x1",
        strategy: "funding-trend",
        role: "informationnel",
        status: "ECHEC",
        raison,
        datasetId: null,
        trades: null,
        pnlUsd: null,
        totalReturn: null,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
        winRateLiquidative: null,
        maxDrawdown: null,
        sharpe: null,
        turnover: null,
        feesUsd: null,
        benchmarkPnlUsd: null,
        benchmarkTotalReturn: null,
        regime: null,
        excessReturn: null,
        medianRequestedNotionalUsd: null,
        verdict: null,
        candidateKey: null,
        durationMs: null,
      };
      fundingCells.push(failed);
      await writeJson(fundingPath, failed);
      console.error(`[ECHEC] funding-trend p75 — ${raison}`);
    }
  }

  const cells = [
    ...runs.flatMap((run) => run.cells),
    ...fundingCells,
  ];
  const primary = cells.filter((cell) => cell.role === "primaire");
  const summary = {
    ok: primary.filter((cell) => cell.status === "OK").length,
    echec: primary.filter((cell) => cell.status === "ECHEC").length,
    edgeDemontre: primary.filter((cell) => cell.verdict === "EDGE_DEMONTRE").length,
    nonDemontre: primary.filter((cell) => cell.verdict === "NON_DEMONTRE").length,
    inactif: primary.filter((cell) => cell.verdict === "INACTIF").length,
  };
  const consolidated = {
    objet: "dao40 — campagne d'edge multi-régimes, grille v2",
    modele: GRID_REF,
    statut: "RESEARCH_ONLY — lecture-seule trading, aucune activation (C2)",
    multiplicity:
      "168 cellules primaires : sous H0, ~la moitié des PnL seraient positifs par hasard ; toute cellule EDGE_DEMONTRE est une candidate exigeant la confirmation OOS pré-enregistrée (models §5-§6, C4)",
    grid: {
      assets: ASSETS,
      windows: WINDOWS.map(({ id, startAt, endAt, expectedCandles }) => ({ id, startAt, endAt, expectedCandles })),
      calibrations: CALIBRATIONS,
      costArms: COST_ARMS,
      primaryStrategies: PRIMARY_STRATEGIES,
      inactivityMedianNotionalUsd: INACTIVITY_MEDIAN_NOTIONAL_USD,
    },
    startedAt: new Date(startedAt).toISOString(),
    generatedAt: new Date().toISOString(),
    wallClockMs: Date.now() - startedAt,
    runsCount: runs.length,
    summary,
    runs,
    fundingTrendCells: fundingCells,
    cells,
  };
  await writeJson(`${OUTPUT_DIR}/grid-result.json`, consolidated);
  console.log(
    `\n[grille] runs=${runs.length} cellules primaires OK=${summary.ok} ECHEC=${summary.echec} | verdicts: edge-démontré=${summary.edgeDemontre} non-démontré=${summary.nonDemontre} inactif=${summary.inactif}`,
  );
  console.log(`[grille] artefact consolidé: ${OUTPUT_DIR}/grid-result.json`);
  console.log(
    `[grille] durée totale: ${(consolidated.wallClockMs / 60_000).toFixed(1)} min`,
  );
};

await main();
