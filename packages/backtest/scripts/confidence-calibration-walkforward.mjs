import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCoinbaseHistoricalDataset,
  runBacktestSuite,
} from "@dodash/backtest";
import { createProductId } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  CONFIDENCE_CALIBRATION_PROFILES,
  selectConfidenceCalibrationProfile,
} from "@dodash/models";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-calibration-ETC-ATOM-2022-2026.json",
);
const PRODUCTS = Object.freeze(["ETC-USD", "ATOM-USD"]);
const DEVELOPMENT_FOLDS = Object.freeze([
  Object.freeze({ id: "2022-2023", start: "2022-08-19", end: "2023-08-19" }),
  Object.freeze({ id: "2023-2024", start: "2023-08-19", end: "2024-08-19" }),
  Object.freeze({ id: "2024-2025", start: "2024-08-19", end: "2025-08-19" }),
]);
const HOLDOUT_FOLD = Object.freeze({
  id: "2025-2026",
  start: "2025-08-19",
  end: "2026-08-19",
});
const INITIAL_CAPITAL = 10_000;
const TARGET_SIGNAL_NOTIONAL = 1_000;
const BROKER = Object.freeze({ feeBps: 6, slippageBps: 2 });
const RISK = Object.freeze({
  maxOrderNotional: 2_000,
  maxPositionNotional: 10_000,
  maxGrossExposure: 20_000,
  maxDailyLoss: 1_000,
  cooldownMs: 0,
  stopLossBps: 150,
  takeProfitBps: 300,
});
const PROTECTIVE_EXIT = Object.freeze({
  mode: "FIXED_BPS",
  stopLossBps: 150,
  takeProfitBps: 300,
});
const CALIBRATED_STRATEGIES = Object.freeze(["ema-cross", "breakout"]);

const utc = (date) => Date.parse(`${date}T00:00:00.000Z`);
const runKey = (productId, foldId) => `${productId}:${foldId}`;

const datasetMetadata = (dataset, fold) =>
  Object.freeze({
    productId: dataset.productId,
    foldId: fold.id,
    start: fold.start,
    end: fold.end,
    timeframe: dataset.timeframe,
    datasetId: dataset.datasetId,
    sha256: dataset.sha256,
    candleCount: dataset.candles.length,
  });

const loadDatasets = async (productRaw, fold) => {
  const product = createProductId(productRaw);
  if (!product.ok) throw new Error(`${productRaw}:${JSON.stringify(product.error)}`);
  const request = {
    productId: product.value,
    startAt: utc(fold.start),
    endAt: utc(fold.end),
  };
  const [primary, execution] = await Promise.all([
    loadCoinbaseHistoricalDataset({ ...request, timeframe: "ONE_DAY" }),
    loadCoinbaseHistoricalDataset({ ...request, timeframe: "SIX_HOUR" }),
  ]);
  if (!primary.ok) {
    throw new Error(`${productRaw}:${fold.id}:PRIMARY:${JSON.stringify(primary.error)}`);
  }
  if (!execution.ok) {
    throw new Error(
      `${productRaw}:${fold.id}:EXECUTION:${JSON.stringify(execution.error)}`,
    );
  }
  return Object.freeze({
    primary: primary.value,
    execution: execution.value,
    metadata: Object.freeze({
      primary: datasetMetadata(primary.value, fold),
      execution: datasetMetadata(execution.value, fold),
    }),
  });
};

const suiteConfig = (productId, fold, profile) =>
  Object.freeze({
    runId: `confidence-calibration:${productId}:${fold.id}:${profile}`,
    agentId: "dodash-confidence-calibration",
    initialCapital: INITIAL_CAPITAL,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
    confidenceCalibration: profile,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: RISK,
    broker: BROKER,
    protectiveExit: PROTECTIVE_EXIT,
  });

const selectScenarios = (report) =>
  Object.freeze(
    report.scenarios.filter(({ id }) =>
      ["rsi-reversion", "ema-cross", "breakout", "ensemble"].includes(id),
    ),
  );

const runProfile = async (datasets, fold, profile) => {
  const result = await runBacktestSuite(
    datasets.primary,
    suiteConfig(datasets.primary.productId, fold, profile),
    { executionDataset: datasets.execution },
  );
  if (!result.ok) {
    throw new Error(
      `${datasets.primary.productId}:${fold.id}:${profile}:${JSON.stringify(result.error)}`,
    );
  }
  return Object.freeze({
    profile,
    benchmark: result.value.benchmark,
    scenarios: selectScenarios(result.value),
  });
};

const developmentObservation = (productId, foldId, profileRun, strategyId) => {
  const scenario = profileRun.scenarios.find(({ id }) => id === strategyId);
  const signal = scenario?.diagnostics.signals.byStrategy.find(
    (item) => item.strategyId === strategyId,
  );
  if (scenario === undefined || signal === undefined) {
    throw new Error(`MISSING_SCENARIO:${productId}:${foldId}:${profileRun.profile}:${strategyId}`);
  }
  return Object.freeze({
    profile: profileRun.profile,
    runKey: runKey(productId, foldId),
    strategyId,
    activeSignalCount: signal.activeSignalCount,
    medianRequestedNotional: signal.requestedNotional.median,
    capRate: scenario.diagnostics.allocation.capRate,
    riskRejectionRate: scenario.diagnostics.allocation.riskRejectionRate,
    maxDrawdown: scenario.metrics.maxDrawdown,
    turnover: scenario.metrics.turnover,
    feeRate: scenario.metrics.fees / INITIAL_CAPITAL,
  });
};

const runDevelopment = async () => {
  const datasets = [];
  const runs = [];
  const observations = [];
  for (const fold of DEVELOPMENT_FOLDS) {
    for (const productId of PRODUCTS) {
      console.log(`development ${productId} ${fold.id}`);
      const loaded = await loadDatasets(productId, fold);
      datasets.push(loaded.metadata);
      const profiles = [];
      for (const profile of CONFIDENCE_CALIBRATION_PROFILES) {
        const profileRun = await runProfile(loaded, fold, profile);
        profiles.push(profileRun);
        for (const strategyId of CALIBRATED_STRATEGIES) {
          observations.push(
            developmentObservation(productId, fold.id, profileRun, strategyId),
          );
        }
      }
      runs.push(
        Object.freeze({
          productId,
          foldId: fold.id,
          profiles: Object.freeze(profiles),
        }),
      );
    }
  }
  return Object.freeze({
    datasets: Object.freeze(datasets),
    runs: Object.freeze(runs),
    observations: Object.freeze(observations),
  });
};

const runHoldout = async (selectedProfile) => {
  const profiles =
    selectedProfile === "IDENTITY"
      ? Object.freeze(["IDENTITY"])
      : Object.freeze(["IDENTITY", selectedProfile]);
  const datasets = [];
  const runs = [];
  for (const productId of PRODUCTS) {
    console.log(`holdout ${productId} ${HOLDOUT_FOLD.id}`);
    const loaded = await loadDatasets(productId, HOLDOUT_FOLD);
    datasets.push(loaded.metadata);
    const profileRuns = [];
    for (const profile of profiles) {
      profileRuns.push(await runProfile(loaded, HOLDOUT_FOLD, profile));
    }
    runs.push(
      Object.freeze({
        productId,
        foldId: HOLDOUT_FOLD.id,
        profiles: Object.freeze(profileRuns),
      }),
    );
  }
  return Object.freeze({
    datasets: Object.freeze(datasets),
    runs: Object.freeze(runs),
  });
};

const writeArtifact = async (artifact) => {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
};

const main = async () => {
  const development = await runDevelopment();
  const expectedRunKeys = DEVELOPMENT_FOLDS.flatMap((fold) =>
    PRODUCTS.map((productId) => runKey(productId, fold.id)),
  );
  const selection = selectConfidenceCalibrationProfile(
    expectedRunKeys,
    development.observations,
  );
  if (!selection.ok) throw new Error(JSON.stringify(selection.error));

  const holdout =
    selection.value.selectedProfile === null
      ? null
      : await runHoldout(selection.value.selectedProfile);
  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    status:
      selection.value.selectedProfile === null
        ? "NO_ELIGIBLE_CALIBRATION"
        : "RESEARCH_ONLY",
    products: PRODUCTS,
    timeframe: "ONE_DAY",
    executionTimeframe: "SIX_HOUR",
    executionPolicy: "NEXT_CANDLE_OPEN_THEN_FINE_INTRABAR_RANGE",
    market: "SPOT_LONG_ONLY",
    sizingPolicy: Object.freeze({
      type: "TARGET_SIGNAL_NOTIONAL",
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      calibratedStrategies: CALIBRATED_STRATEGIES,
      referenceStrategy: "rsi-reversion",
    }),
    selectionPolicy: Object.freeze({
      candidateOrder: CONFIDENCE_CALIBRATION_PROFILES,
      expectedDevelopmentRunCount: expectedRunKeys.length,
      requiredMedianRequestedNotionalUsd: Object.freeze([100, 400]),
      maxDrawdown: 0.1,
      maxTurnover: 10,
      maxFeeRate: 0.01,
      pnlUsedForRanking: false,
      holdoutLoadedAfterSelection: true,
      holdoutUsedForRanking: false,
    }),
    invariants: Object.freeze([
      "candidate profiles and thresholds frozen before dataset execution",
      "same profile applied to EMA and breakout; RSI remains identity",
      "signal side, reason and target sizing remain unchanged",
      "development uses equal weight per product/fold",
      "holdout datasets load only after development selection",
      "holdout never participates in ranking",
      "identical capital, fees, slippage, brackets and risk limits",
      "no result can enable live trading",
    ]),
    folds: Object.freeze({
      development: DEVELOPMENT_FOLDS,
      holdout: HOLDOUT_FOLD,
    }),
    config: Object.freeze({
      initialCapital: INITIAL_CAPITAL,
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      broker: BROKER,
      risk: RISK,
      protectiveExit: PROTECTIVE_EXIT,
      indicators: DEFAULT_INDICATOR_CONFIG,
    }),
    development: Object.freeze({
      datasets: development.datasets,
      observations: development.observations,
      runs: development.runs,
    }),
    selection: selection.value,
    holdout,
  });
  await writeArtifact(artifact);
  console.log(`selected=${selection.value.selectedProfile ?? "none"}`);
  console.log(`artifact=${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
