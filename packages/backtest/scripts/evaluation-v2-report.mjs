// Rapport d'évaluation v2 (dao #39) — models/backtest-diagnostics.md,
// section « Évaluation v2 — métriques primaires et régime du benchmark ».
//
// Produit, par run, les métriques primaires (PnL absolu, win rate liquidatif
// INV-26, drawdown, Sharpe, turnover, frais) et rapporte l'excess vs
// benchmark uniquement comme métrique contextuelle, accompagnée du régime du
// benchmark calculé au seuil figé à zéro — jamais déclaré à la main.
// Ce rapport n'active aucune stratégie et ne déclare aucun edge : il dit ce
// que les chiffres disent, en absolu.
//
// Contenu :
// 1. fenêtre principale BTC-USD ONE_DAY 2025-09-01 → 2026-09-01, un dataset
//    unique rejoué deux fois : calibration IDENTITY (v1) puis POWER_THIRD
//    (option documentée — CLI `--confidence-calibration POWER_THIRD`, config
//    suite `confidenceCalibration` ; la calibration s'applique à ema-cross et
//    breakout, rsi-reversion reste en identité) ;
// 2. relecture en absolu du holdout ETC/ATOM de l'artefact d'étude existant
//    `confidence-calibration-ETC-ATOM-2022-2026.json` (aucun rejeu : lecture
//    compatible, une métrique absente reste null).
//
// Usage : node scripts/evaluation-v2-report.mjs [chemin artefact holdout]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_REGIME_THRESHOLD,
  evaluateV2,
  loadCoinbaseHistoricalDataset,
  runBacktestSuite,
} from "@dodash/backtest";
import { createProductId } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HOLDOUT_ARTIFACT_DEFAULT = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-calibration-ETC-ATOM-2022-2026.json",
);
const OUTPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/evaluation-v2-2026-09.json",
);
const MAIN_WINDOW = Object.freeze({
  productId: "BTC-USD",
  timeframe: "ONE_DAY",
  start: "2025-09-01",
  end: "2026-09-01",
});
const PROFILES = Object.freeze(["IDENTITY", "POWER_THIRD"]);
const INITIAL_CAPITAL = 10_000;

const utc = (date) => Date.parse(`${date}T00:00:00.000Z`);

// Config par défaut du CLI (src/cli.ts) : une seule variable varie entre v1
// et POWER_THIRD — la calibration. Même dataset, mêmes paramètres non
// stratégiques (models/backtest-run.md).
const suiteConfig = (profile) =>
  Object.freeze({
    runId: `evaluation-v2:${MAIN_WINDOW.productId}:${MAIN_WINDOW.timeframe}:${profile}`,
    agentId: "dodash-evaluation-v2",
    initialCapital: INITIAL_CAPITAL,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: 1_000,
    confidenceCalibration: profile,
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
    broker: Object.freeze({ feeBps: 6, slippageBps: 2 }),
  });

const datasetFingerprint = (dataset) =>
  Object.freeze({
    productId: dataset.productId,
    timeframe: dataset.timeframe,
    startAt: dataset.startAt,
    endAt: dataset.endAt,
    datasetId: dataset.datasetId,
    sha256: dataset.sha256,
    candleCount: dataset.candles.length,
  });

const scenarioV2 = (scenario, benchmark) => {
  const entry = evaluateV2(scenario.id, scenario.metrics, {
    pnl: benchmark.pnl,
    totalReturn: benchmark.totalReturn,
  });
  if (!entry.ok) {
    throw new Error(`EVALUATION_V2:${scenario.id}:${entry.error.code}`);
  }
  return entry.value;
};

const runMainWindow = async (dataset) => {
  const runs = [];
  for (const profile of PROFILES) {
    console.log(`main-window ${MAIN_WINDOW.productId} ${profile}`);
    const result = await runBacktestSuite(dataset, suiteConfig(profile));
    if (!result.ok) {
      throw new Error(
        `MAIN_WINDOW:${profile}:${JSON.stringify(result.error)}`,
      );
    }
    const benchmark = result.value.benchmark;
    runs.push(
      Object.freeze({
        profile,
        benchmark: Object.freeze({ ...benchmark }),
        scenarios: Object.freeze(
          result.value.scenarios.map((scenario) => scenarioV2(scenario, benchmark)),
        ),
        tradeCountByScenario: Object.fromEntries(
          result.value.scenarios.map((scenario) => [scenario.id, scenario.tradeCount]),
        ),
        medianRequestedNotionalByScenario: Object.fromEntries(
          result.value.scenarios.map((scenario) => [
            scenario.id,
            Object.fromEntries(
              scenario.diagnostics.signals.byStrategy.map((signal) => [
                signal.strategyId,
                signal.requestedNotional.median,
              ]),
            ),
          ]),
        ),
      }),
    );
  }
  return Object.freeze(runs);
};

// Relecture compatible des artefacts d'études passés (C3) : lecture seule,
// aucune écriture, aucune valeur reconstituée.
const readHoldout = async (artifactPath) => {
  const raw = JSON.parse(await readFile(artifactPath, "utf8"));
  const holdout = raw.holdout;
  if (holdout === null || holdout === undefined) {
    throw new Error(`HOLDOUT_MISSING:${artifactPath}`);
  }
  const runs = [];
  for (const run of holdout.runs) {
    const profileRun = run.profiles.find(
      (profile) => profile.profile === "POWER_THIRD",
    );
    if (profileRun === undefined) {
      throw new Error(`HOLDOUT_PROFILE_MISSING:${run.productId}:POWER_THIRD`);
    }
    runs.push(
      Object.freeze({
        productId: run.productId,
        foldId: run.foldId,
        benchmark: Object.freeze({ ...profileRun.benchmark }),
        scenarios: Object.freeze(
          profileRun.scenarios.map((scenario) =>
            scenarioV2(scenario, profileRun.benchmark),
          ),
        ),
        tradeCountByScenario: Object.fromEntries(
          profileRun.scenarios.map((scenario) => [scenario.id, scenario.tradeCount]),
        ),
      }),
    );
  }
  return Object.freeze({
    sourceArtifact: artifactPath,
    status: raw.status,
    runs,
  });
};

const percent = (value) =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
const usd = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} $`;

const printEntry = (label, entry, tradeCount) => {
  console.log(
    [
      label,
      entry.scenarioId,
      `trades=${tradeCount}`,
      `pnl=${usd(entry.primary.pnlUsd)}`,
      `retour=${percent(entry.primary.totalReturn)}`,
      `wrLiq=${percent(entry.primary.winRateLiquidative)}`,
      `dd=${percent(entry.primary.maxDrawdown)}`,
      `sharpe=${entry.primary.sharpe.toFixed(3)}`,
      `turnover=${entry.primary.turnover.toFixed(2)}`,
      `frais=${usd(entry.primary.feesUsd)}`,
      `bench=${entry.benchmark.regime} ${percent(entry.benchmark.totalReturn)}`,
      `excess(ctx)=${percent(entry.contextual.excessReturn)}`,
    ].join(" | "),
  );
};

const main = async () => {
  const holdoutPath = process.argv[2]
    ? resolve(process.argv[2])
    : HOLDOUT_ARTIFACT_DEFAULT;
  const product = createProductId(MAIN_WINDOW.productId);
  if (!product.ok) throw new Error(JSON.stringify(product.error));
  const dataset = await loadCoinbaseHistoricalDataset({
    productId: product.value,
    timeframe: MAIN_WINDOW.timeframe,
    startAt: utc(MAIN_WINDOW.start),
    endAt: utc(MAIN_WINDOW.end),
  });
  if (!dataset.ok) {
    throw new Error(`DATASET:${JSON.stringify(dataset.error)}`);
  }
  console.log(`Dataset: ${dataset.value.datasetId}`);

  const mainWindowRuns = await runMainWindow(dataset.value);
  const holdout = await readHoldout(holdoutPath);

  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    status: "RESEARCH_ONLY",
    model: "models/backtest-diagnostics.md#evaluation-v2",
    readingRule: Object.freeze({
      primaryMetrics: Object.freeze([
        "pnlUsd",
        "totalReturn",
        "realizedPnlUsd",
        "unrealizedPnlUsd",
        "winRateLiquidative",
        "maxDrawdown",
        "sharpe",
        "turnover",
        "feesUsd",
      ]),
      contextualMetrics: Object.freeze(["excessReturn"]),
      verdictPolicy:
        "seules les métriques primaires soutiennent un verdict ; aucune stratégie n'est activée ni déclarée edge",
      legacyCompat:
        "une métrique absente d'un artefact legacy reste null, sans reconstitution",
    }),
    benchmarkRegimeThreshold: BENCHMARK_REGIME_THRESHOLD,
    mainWindow: Object.freeze({
      ...MAIN_WINDOW,
      dataset: datasetFingerprint(dataset.value),
      runs: mainWindowRuns,
    }),
    holdout,
  });
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log("\n=== Fenêtre principale (rejeu v1 vs POWER_THIRD) ===");
  for (const run of mainWindowRuns) {
    console.log(`-- calibration ${run.profile} --`);
    for (const entry of run.scenarios) {
      printEntry("main", entry, run.tradeCountByScenario[entry.scenarioId]);
    }
    console.log(
      `benchmark buy-and-hold: ${usd(run.benchmark.pnl)} ${percent(run.benchmark.totalReturn)}`,
    );
  }
  console.log("\n=== Holdout ETC/ATOM relu en absolu (artefact existant) ===");
  for (const run of holdout.runs) {
    console.log(`-- ${run.productId} ${run.foldId} --`);
    for (const entry of run.scenarios) {
      printEntry("holdout", entry, run.tradeCountByScenario[entry.scenarioId]);
    }
  }
  console.log(`\nArtifact: ${OUTPUT_PATH}`);
  console.log("Statut RESEARCH_ONLY : faits absolus, aucun verdict d'edge.");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
