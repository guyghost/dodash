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
  assessConfidenceQuantileSensitivity,
  CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES,
  CONFIDENCE_QUANTILE_ESTIMATORS,
  CONFIDENCE_QUANTILE_SENSITIVITY_POLICY,
  estimateQuantile,
} from "@dodash/models";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json",
);
const TEMPORARY_OUTPUT_PATH = `${OUTPUT_PATH}.${process.pid}.tmp`;
const POPULATIONS = Object.freeze([
  Object.freeze({
    id: "REFERENCE",
    purpose: "ESTIMATOR_SENSITIVITY",
    products: Object.freeze(["XTZ-USD", "ZEC-USD"]),
  }),
  Object.freeze({
    id: "EXTERNAL",
    purpose: "FROZEN_POLICY_CONFIRMATION",
    products: Object.freeze(["GRT-USD", "MANA-USD"]),
  }),
]);
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

const suiteConfig = (populationId, productId, fold, profile) =>
  Object.freeze({
    runId: `confidence-quantile-sensitivity:${populationId}:${productId}:${fold.id}:${profile}`,
    agentId: "dodash-confidence-quantile-sensitivity",
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

const artifactScenario = ({ diagnosticSamples: _samples, ...scenario }) =>
  Object.freeze(scenario);

const runProfile = async (populationId, datasets, fold, profile) => {
  const result = await runBacktestSuite(
    datasets.primary,
    suiteConfig(populationId, datasets.primary.productId, fold, profile),
    {
      executionDataset: datasets.execution,
      includeDiagnosticSamples: true,
    },
  );
  if (!result.ok) {
    throw new Error(
      `${populationId}:${datasets.primary.productId}:${fold.id}:${profile}:${JSON.stringify(result.error)}`,
    );
  }
  return Object.freeze({
    profile,
    benchmark: result.value.benchmark,
    scenarios: result.value.scenarios,
    artifactScenarios: Object.freeze(
      result.value.scenarios.map(artifactScenario),
    ),
  });
};

const checkedQuantile = (values, probability, estimator, context) => {
  const result = estimateQuantile(values, probability, estimator);
  if (!result.ok) {
    throw new Error(`${context}:${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const observation = (productId, foldId, profileRun, strategyId) => {
  const scenario = profileRun.scenarios.find(({ id }) => id === strategyId);
  const signal = scenario?.diagnostics.signals.byStrategy.find(
    (item) => item.strategyId === strategyId,
  );
  const sampleProjection =
    scenario?.diagnosticSamples?.requestedNotionalByStrategy.find(
      (item) => item.strategyId === strategyId,
    );
  if (scenario === undefined || signal === undefined || sampleProjection === undefined) {
    throw new Error(
      `MISSING_SAMPLES:${productId}:${foldId}:${profileRun.profile}:${strategyId}`,
    );
  }
  const context = `${productId}:${foldId}:${profileRun.profile}:${strategyId}`;
  const reconstructedMedian = checkedQuantile(
    sampleProjection.values,
    0.5,
    "LINEAR_R7",
    context,
  );
  const reconstructedP95 = checkedQuantile(
    sampleProjection.values,
    0.95,
    "LINEAR_R7",
    context,
  );
  if (
    reconstructedMedian !== signal.requestedNotional.median ||
    reconstructedP95 !== signal.requestedNotional.p95 ||
    sampleProjection.values.length !== signal.activeSignalCount
  ) {
    throw new Error(`DIAGNOSTIC_RECONCILIATION_FAILED:${context}`);
  }
  return Object.freeze({
    profile: profileRun.profile,
    runKey: runKey(productId, foldId),
    strategyId,
    evaluationCount: signal.evaluationCount,
    activeSignalCount: signal.activeSignalCount,
    buySignalCount: signal.buySignalCount,
    sellSignalCount: signal.sellSignalCount,
    requestedNotionalSamples: sampleProjection.values,
    capRate: scenario.diagnostics.allocation.capRate,
    riskRejectionRate: scenario.diagnostics.allocation.riskRejectionRate,
    maxDrawdown: scenario.metrics.maxDrawdown,
    turnover: scenario.metrics.turnover,
    feeRate: scenario.metrics.fees / INITIAL_CAPITAL,
  });
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const invariant = (productId, foldId, profiles) => {
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

const runPopulation = async (population) => {
  const datasets = [];
  const runs = [];
  const observations = [];
  const runInvariants = [];
  for (const fold of FOLDS) {
    for (const productId of population.products) {
      console.log(`${population.id.toLowerCase()} ${productId} ${fold.id}`);
      const loaded = await loadDatasets(productId, fold);
      datasets.push(loaded.metadata);
      const profiles = await Promise.all(
        CONFIDENCE_CALIBRATION_CONFIRMATION_PROFILES.map((profile) =>
          runProfile(population.id, loaded, fold, profile),
        ),
      );
      for (const profileRun of profiles) {
        for (const strategyId of CALIBRATED_STRATEGIES) {
          observations.push(
            observation(productId, fold.id, profileRun, strategyId),
          );
        }
      }
      runInvariants.push(invariant(productId, fold.id, profiles));
      runs.push(
        Object.freeze({
          productId,
          foldId: fold.id,
          profiles: Object.freeze(
            profiles.map(({ profile, benchmark, artifactScenarios }) =>
              Object.freeze({
                profile,
                benchmark,
                scenarios: artifactScenarios,
              }),
            ),
          ),
        }),
      );
    }
  }
  const expectedRunKeys = FOLDS.flatMap((fold) =>
    population.products.map((productId) => runKey(productId, fold.id)),
  );
  const assessment = assessConfidenceQuantileSensitivity(
    expectedRunKeys,
    observations,
    runInvariants,
  );
  if (!assessment.ok) throw new Error(JSON.stringify(assessment.error));
  return Object.freeze({
    id: population.id,
    purpose: population.purpose,
    products: population.products,
    expectedRunKeys: Object.freeze(expectedRunKeys),
    datasets: Object.freeze(datasets),
    observations: Object.freeze(observations),
    runInvariants: Object.freeze(runInvariants),
    runs: Object.freeze(runs),
    assessment: assessment.value,
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
  const reference = await runPopulation(POPULATIONS[0]);
  const external = await runPopulation(POPULATIONS[1]);
  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    status: "RESEARCH_ONLY",
    verdict: external.assessment.selectedVerdict,
    sensitivityVerdict: reference.assessment.sensitivityVerdict,
    selectedEstimator: CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator,
    protocol: Object.freeze({
      declaredBeforeExternalMarketData: true,
      selectedEstimatorBasedOnReferenceResults: false,
      externalProductsAbsentFromLocalStudiesAtDeclaration: true,
      localAbsenceLimitation:
        "local absence does not prove the assets were never observed outside this repository",
      probability: CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability,
      estimators: CONFIDENCE_QUANTILE_ESTIMATORS,
      medianEstimator:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.medianEstimator,
      selectedEstimator:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator,
      selectedEstimatorRationale:
        "conservative empirical quantile that is always observed and does not understate the requested rank",
      maxP95RequestedNotionalUsd:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional,
      maxP95ToMedianRatio:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio,
      previousVerdictsReinterpreted: false,
      profileReselectionAllowed: false,
      pnlUsedForVerdict: false,
      invalidProtocolHistory: Object.freeze({
        products: Object.freeze(["MKR-USD", "COMP-USD"]),
        terminalState: "INVALID_EVIDENCE",
        cause:
          "MKR-USD:2025-2026:PRIMARY:INCOMPLETE_HISTORICAL_DATA",
        finalArtifactWritten: false,
        externalVerdictProduced: false,
        currentProtocolDeclaredBeforeGRTMANAData: true,
      }),
    }),
    folds: FOLDS,
    timeframe: "ONE_DAY",
    executionTimeframe: "SIX_HOUR",
    executionPolicy: "NEXT_CANDLE_OPEN_THEN_FINE_INTRABAR_RANGE",
    market: "SPOT_LONG_ONLY",
    frozenProfile: "POWER_THIRD",
    baselineProfile: "IDENTITY",
    sizingPolicy: Object.freeze({
      type: "TARGET_SIGNAL_NOTIONAL",
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      calibratedStrategies: CALIBRATED_STRATEGIES,
      referenceStrategy: "rsi-reversion",
    }),
    config: Object.freeze({
      initialCapital: INITIAL_CAPITAL,
      targetSignalNotional: TARGET_SIGNAL_NOTIONAL,
      broker: BROKER,
      risk: RISK,
      protectiveExit: PROTECTIVE_EXIT,
      indicators: DEFAULT_INDICATOR_CONFIG,
    }),
    invariants: Object.freeze([
      "estimators, selected estimator, products, folds and thresholds frozen before external market-data loading",
      "all estimators consume identical requested-notional samples",
      "R7 median remains the denominator and ratio limit remains two",
      "reference sensitivity cannot reselect the external estimator",
      "signal evaluation, active, BUY and SELL counts identical across profiles",
      "RSI and benchmark identical across profiles",
      "invalid evidence cannot produce a sensitivity or external verdict",
      "PnL cannot affect the verdict or enable live trading",
    ]),
    evidence: Object.freeze({ reference, external }),
  });
  await writeArtifact(artifact);
  console.log(`sensitivity=${reference.assessment.sensitivityVerdict}`);
  console.log(`verdict=${external.assessment.selectedVerdict}`);
  console.log(`artifact=${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
