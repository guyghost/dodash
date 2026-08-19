import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCoinbaseHistoricalDataset,
  runBacktestSuite,
} from "@dodash/backtest";
import { createProductId } from "@dodash/domain";
import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";
import {
  assessConfidenceCalibrationConfirmation,
  CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES,
} from "@dodash/models";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-calibration-confirmation-ALGO-FIL-2022-2026.json",
);
const TEMPORARY_OUTPUT_PATH = `${OUTPUT_PATH}.${process.pid}.tmp`;
const PRODUCTS = Object.freeze(["ALGO-USD", "FIL-USD"]);
const FOLDS = Object.freeze([
  Object.freeze({ id: "2022-2023", start: "2022-08-19", end: "2023-08-19" }),
  Object.freeze({ id: "2023-2024", start: "2023-08-19", end: "2024-08-19" }),
  Object.freeze({ id: "2024-2025", start: "2024-08-19", end: "2025-08-19" }),
  Object.freeze({ id: "2025-2026", start: "2025-08-19", end: "2026-08-19" }),
]);
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
  if (!product.ok) {
    throw new Error(`${productRaw}:${JSON.stringify(product.error)}`);
  }
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
    throw new Error(
      `${productRaw}:${fold.id}:PRIMARY:${JSON.stringify(primary.error)}`,
    );
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
    runId: `confidence-confirmation:${productId}:${fold.id}:${profile}`,
    agentId: "dodash-confidence-calibration-confirmation",
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

const confirmationObservation = (
  productId,
  foldId,
  profileRun,
  strategyId,
) => {
  const scenario = profileRun.scenarios.find(({ id }) => id === strategyId);
  const signal = scenario?.diagnostics.signals.byStrategy.find(
    (item) => item.strategyId === strategyId,
  );
  if (scenario === undefined || signal === undefined) {
    throw new Error(
      `MISSING_SCENARIO:${productId}:${foldId}:${profileRun.profile}:${strategyId}`,
    );
  }
  return Object.freeze({
    profile: profileRun.profile,
    runKey: runKey(productId, foldId),
    strategyId,
    evaluationCount: signal.evaluationCount,
    activeSignalCount: signal.activeSignalCount,
    buySignalCount: signal.buySignalCount,
    sellSignalCount: signal.sellSignalCount,
    medianRequestedNotional: signal.requestedNotional.median,
    p95RequestedNotional: signal.requestedNotional.p95,
    capRate: scenario.diagnostics.allocation.capRate,
    riskRejectionRate: scenario.diagnostics.allocation.riskRejectionRate,
    maxDrawdown: scenario.metrics.maxDrawdown,
    turnover: scenario.metrics.turnover,
    feeRate: scenario.metrics.fees / INITIAL_CAPITAL,
  });
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const runInvariant = (productId, foldId, profiles) => {
  const baseline = profiles.find(({ profile }) => profile === "IDENTITY");
  const calibrated = profiles.find(({ profile }) => profile === "POWER_THIRD");
  const baselineReference = baseline?.scenarios.find(
    ({ id }) => id === "rsi-reversion",
  );
  const calibratedReference = calibrated?.scenarios.find(
    ({ id }) => id === "rsi-reversion",
  );
  if (
    baseline === undefined ||
    calibrated === undefined ||
    baselineReference === undefined ||
    calibratedReference === undefined
  ) {
    throw new Error(`MISSING_REFERENCE:${productId}:${foldId}`);
  }
  return Object.freeze({
    runKey: runKey(productId, foldId),
    benchmarkUnchanged: sameJson(baseline.benchmark, calibrated.benchmark),
    referenceScenarioUnchanged: sameJson(
      baselineReference,
      calibratedReference,
    ),
  });
};

const runConfirmation = async () => {
  const datasets = [];
  const runs = [];
  const observations = [];
  const runInvariants = [];
  for (const fold of FOLDS) {
    for (const productId of PRODUCTS) {
      console.log(`confirmation ${productId} ${fold.id}`);
      const loaded = await loadDatasets(productId, fold);
      datasets.push(loaded.metadata);
      const profiles = [];
      for (const profile of CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES) {
        const profileRun = await runProfile(loaded, fold, profile);
        profiles.push(profileRun);
        for (const strategyId of CALIBRATED_STRATEGIES) {
          observations.push(
            confirmationObservation(
              productId,
              fold.id,
              profileRun,
              strategyId,
            ),
          );
        }
      }
      runInvariants.push(runInvariant(productId, fold.id, profiles));
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
    runInvariants: Object.freeze(runInvariants),
  });
};

const writeArtifact = async (artifact) => {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  try {
    await writeFile(
      TEMPORARY_OUTPUT_PATH,
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    await rename(TEMPORARY_OUTPUT_PATH, OUTPUT_PATH);
  } catch (error) {
    await unlink(TEMPORARY_OUTPUT_PATH).catch(() => undefined);
    throw error;
  }
};

const main = async () => {
  const expectedRunKeys = FOLDS.flatMap((fold) =>
    PRODUCTS.map((productId) => runKey(productId, fold.id)),
  );
  const confirmation = await runConfirmation();
  const assessment = assessConfidenceCalibrationConfirmation(
    expectedRunKeys,
    confirmation.observations,
    confirmation.runInvariants,
  );
  if (!assessment.ok) throw new Error(JSON.stringify(assessment.error));

  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    status: "RESEARCH_ONLY",
    verdict: assessment.value.verdict,
    products: PRODUCTS,
    folds: FOLDS,
    timeframe: "ONE_DAY",
    executionTimeframe: "SIX_HOUR",
    executionPolicy: "NEXT_CANDLE_OPEN_THEN_FINE_INTRABAR_RANGE",
    market: "SPOT_LONG_ONLY",
    frozenProfile: "POWER_THIRD",
    baselineProfile: "IDENTITY",
    assetSelection: Object.freeze({
      declaredBeforeMarketData: true,
      absentFromLocalStudyArtifactNames: true,
      limitation:
        "local absence does not prove the assets were never observed outside this repository",
    }),
    sizingPolicy: Object.freeze({
      type: "TARGET_SIGNAL_NOTIONAL",
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      calibratedStrategies: CALIBRATED_STRATEGIES,
      referenceStrategy: "rsi-reversion",
    }),
    confirmationPolicy: Object.freeze({
      expectedRunCount: expectedRunKeys.length,
      requiredMedianRequestedNotionalUsd: Object.freeze([100, 400]),
      minimumInBandRunRate: 0.75,
      maxDrawdown: 0.1,
      maxTurnover: 10,
      maxFeeRate: 0.01,
      pnlUsedForVerdict: false,
      profileReselectionAllowed: false,
    }),
    invariants: Object.freeze([
      "POWER_THIRD and thresholds frozen before market-data loading",
      "IDENTITY is descriptive and cannot replace the frozen profile",
      "signal evaluation, active, BUY and SELL counts identical across profiles",
      "RSI and benchmark identical across profiles",
      "equal weight per product/fold",
      "invalid evidence cannot produce a confirmation verdict",
      "no result can enable live trading",
    ]),
    config: Object.freeze({
      initialCapital: INITIAL_CAPITAL,
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      broker: BROKER,
      risk: RISK,
      protectiveExit: PROTECTIVE_EXIT,
      indicators: DEFAULT_INDICATOR_CONFIG,
    }),
    evidence: Object.freeze({
      datasets: confirmation.datasets,
      observations: confirmation.observations,
      runInvariants: confirmation.runInvariants,
      runs: confirmation.runs,
    }),
    assessment: assessment.value,
  });
  await writeArtifact(artifact);
  console.log(`verdict=${assessment.value.verdict}`);
  console.log(`artifact=${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
