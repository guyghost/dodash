import type { CalibratedStrategyId } from "./confidence-calibration.js";
import {
  CONFIDENCE_QUANTILE_SENSITIVITY_POLICY,
  estimateQuantile,
} from "./confidence-quantile-sensitivity.js";

export const CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS = Object.freeze([
  "REFERENCE",
  "EXTERNAL",
] as const);

export type ConfidenceQuantileSampleSizePopulation =
  (typeof CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS)[number];

export const CONFIDENCE_QUANTILE_DISCRETE_ESTIMATORS = Object.freeze([
  "LOWER",
  "NEAREST_RANK",
  "HIGHER",
] as const);

export type ConfidenceQuantileDiscreteEstimator =
  (typeof CONFIDENCE_QUANTILE_DISCRETE_ESTIMATORS)[number];

export const CONFIDENCE_QUANTILE_SAMPLE_SIZE_EXPECTED_RUN_KEYS = Object.freeze({
  REFERENCE: Object.freeze([
    "XTZ-USD:2022-2023",
    "ZEC-USD:2022-2023",
    "XTZ-USD:2023-2024",
    "ZEC-USD:2023-2024",
    "XTZ-USD:2024-2025",
    "ZEC-USD:2024-2025",
    "XTZ-USD:2025-2026",
    "ZEC-USD:2025-2026",
  ]),
  EXTERNAL: Object.freeze([
    "GRT-USD:2022-2023",
    "MANA-USD:2022-2023",
    "GRT-USD:2023-2024",
    "MANA-USD:2023-2024",
    "GRT-USD:2024-2025",
    "MANA-USD:2024-2025",
    "GRT-USD:2025-2026",
    "MANA-USD:2025-2026",
  ]),
});

const STRATEGY_IDS = Object.freeze([
  "ema-cross",
  "breakout",
] as const satisfies readonly CalibratedStrategyId[]);

export type ConfidenceQuantileRankResolution =
  | "NO_ACTIVE_SIGNALS"
  | "MAXIMUM"
  | "ONE_ABOVE"
  | "TWO_OR_MORE_ABOVE";

export const CONFIDENCE_QUANTILE_RANK_RESOLUTIONS = Object.freeze([
  "NO_ACTIVE_SIGNALS",
  "MAXIMUM",
  "ONE_ABOVE",
  "TWO_OR_MORE_ABOVE",
] as const satisfies readonly ConfidenceQuantileRankResolution[]);

export interface ConfidenceQuantileRankPosition {
  readonly rank: number | null;
  readonly observationsAboveRank: number;
  readonly resolution: ConfidenceQuantileRankResolution;
}

export interface ConfidenceQuantileSampleSizeObservation {
  readonly populationId: ConfidenceQuantileSampleSizePopulation;
  readonly runKey: string;
  readonly strategyId: CalibratedStrategyId;
  readonly activeSignalCount: number;
  readonly requestedNotionalSamples: readonly number[];
}

export interface ConfidenceQuantileSampleSizeProtocolEvidence {
  readonly selectedEstimator: "NEAREST_RANK";
  readonly medianEstimator: "LINEAR_R7";
  readonly probability: 0.95;
  readonly maxP95RequestedNotional: 600;
  readonly maxP95ToMedianRatio: 2;
}

export interface ConfidenceQuantileSampleSizeCase
  extends ConfidenceQuantileRankPosition {
  readonly populationId: ConfidenceQuantileSampleSizePopulation;
  readonly runKey: string;
  readonly strategyId: CalibratedStrategyId;
  readonly activeSignalCount: number;
  readonly medianRequestedNotional: number | null;
  readonly p95RequestedNotionalByEstimator: Readonly<
    Record<ConfidenceQuantileDiscreteEstimator, number | null>
  >;
  readonly selectedP95RequestedNotional: number | null;
  readonly selectedP95ToMedianRatio: number | null;
  readonly selectedAbsoluteBreach: boolean;
  readonly selectedRatioBreach: boolean;
  readonly discreteP95SpreadUsd: number | null;
  readonly discreteP95SpreadToMedian: number | null;
  readonly discreteVerdictDisagreement: boolean;
}

export interface ConfidenceQuantileSampleSizeSummary {
  readonly populationId: ConfidenceQuantileSampleSizePopulation;
  readonly resolution: ConfidenceQuantileRankResolution;
  readonly caseCount: number;
  readonly activeCaseCount: number;
  readonly minActiveSignalCount: number | null;
  readonly maxActiveSignalCount: number | null;
  readonly selectedAbsoluteBreachCount: number;
  readonly selectedRatioBreachCount: number;
  readonly discreteVerdictDisagreementCount: number;
  readonly maxDiscreteP95SpreadUsd: number | null;
  readonly maxDiscreteP95SpreadToMedian: number | null;
}

export interface ConfidenceQuantileSampleSizeAssessment {
  readonly status: "RESEARCH_ONLY";
  readonly selectedEstimator: "NEAREST_RANK";
  readonly maxP95RequestedNotional: 600;
  readonly maxP95ToMedianRatio: 2;
  readonly liveAuthorization: false;
  readonly liquidityValidated: false;
  readonly alphaValidated: false;
  readonly cases: readonly ConfidenceQuantileSampleSizeCase[];
  readonly summaries: readonly ConfidenceQuantileSampleSizeSummary[];
}

export type ConfidenceQuantileSampleSizeResult =
  | { readonly ok: true; readonly value: ConfidenceQuantileSampleSizeAssessment }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_CONFIDENCE_QUANTILE_SAMPLE_SIZE_EVIDENCE";
      };
    };

export type LessCorrelatedAssetUniverse =
  | "CRYPTO_SPOT"
  | "EQUITIES"
  | "FX"
  | "RATES"
  | "COMMODITIES";

export interface LessCorrelatedReplicationSource {
  readonly sourceId: string;
  readonly assetUniverse: LessCorrelatedAssetUniverse;
  readonly configured: boolean;
  readonly accessAvailable: boolean;
  readonly timeframes: readonly ("ONE_DAY" | "SIX_HOUR")[];
  readonly completeFoldCoverage: boolean;
  readonly ohlcvAvailable: boolean;
  readonly timestampsDocumented: boolean;
  readonly adjustmentPolicyDocumented: boolean;
  readonly executionComparable: boolean;
}

export interface LessCorrelatedReplicationSourceAssessment {
  readonly availability: "AVAILABLE" | "UNAVAILABLE";
  readonly replicationStatus:
    | "NOT_EXECUTED_SOURCE_UNAVAILABLE"
    | "NOT_EXECUTED_PREREGISTRATION_REQUIRED";
  readonly checkedSourceCount: number;
  readonly eligibleSourceIds: readonly string[];
}

export type LessCorrelatedReplicationSourceResult =
  | {
      readonly ok: true;
      readonly value: LessCorrelatedReplicationSourceAssessment;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "INVALID_LESS_CORRELATED_REPLICATION_SOURCES";
      };
    };

export const classifyConfidenceQuantileRankResolution = (
  activeSignalCount: number,
): ConfidenceQuantileRankPosition | null => {
  if (!Number.isSafeInteger(activeSignalCount) || activeSignalCount < 0) {
    return null;
  }
  if (activeSignalCount === 0) {
    return Object.freeze({
      rank: null,
      observationsAboveRank: 0,
      resolution: "NO_ACTIVE_SIGNALS" as const,
    });
  }
  const rank = Math.ceil(
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability * activeSignalCount,
  );
  const observationsAboveRank = activeSignalCount - rank;
  return Object.freeze({
    rank,
    observationsAboveRank,
    resolution:
      observationsAboveRank === 0
        ? ("MAXIMUM" as const)
        : observationsAboveRank === 1
          ? ("ONE_ABOVE" as const)
          : ("TWO_OR_MORE_ABOVE" as const),
  });
};

const LESS_CORRELATED_UNIVERSES = Object.freeze([
  "EQUITIES",
  "FX",
  "RATES",
  "COMMODITIES",
] as const satisfies readonly LessCorrelatedAssetUniverse[]);

const validReplicationSource = (
  source: LessCorrelatedReplicationSource,
): boolean =>
  source !== null &&
  typeof source === "object" &&
  typeof source.sourceId === "string" &&
  source.sourceId.trim().length > 0 &&
  [
    "CRYPTO_SPOT",
    "EQUITIES",
    "FX",
    "RATES",
    "COMMODITIES",
  ].includes(source.assetUniverse) &&
  typeof source.configured === "boolean" &&
  typeof source.accessAvailable === "boolean" &&
  Array.isArray(source.timeframes) &&
  source.timeframes.every(
    (timeframe) => timeframe === "ONE_DAY" || timeframe === "SIX_HOUR",
  ) &&
  typeof source.completeFoldCoverage === "boolean" &&
  typeof source.ohlcvAvailable === "boolean" &&
  typeof source.timestampsDocumented === "boolean" &&
  typeof source.adjustmentPolicyDocumented === "boolean" &&
  typeof source.executionComparable === "boolean";

const eligibleReplicationSource = (
  source: LessCorrelatedReplicationSource,
): boolean =>
  LESS_CORRELATED_UNIVERSES.some(
    (universe) => universe === source.assetUniverse,
  ) &&
  source.configured &&
  source.accessAvailable &&
  source.timeframes.includes("ONE_DAY") &&
  source.timeframes.includes("SIX_HOUR") &&
  source.completeFoldCoverage &&
  source.ohlcvAvailable &&
  source.timestampsDocumented &&
  source.adjustmentPolicyDocumented &&
  source.executionComparable;

export const assessLessCorrelatedReplicationSources = (
  sources: readonly LessCorrelatedReplicationSource[],
): LessCorrelatedReplicationSourceResult => {
  if (
    !Array.isArray(sources) ||
    sources.some((source) => !validReplicationSource(source)) ||
    new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length
  ) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "INVALID_LESS_CORRELATED_REPLICATION_SOURCES" as const,
      }),
    });
  }
  const eligibleSourceIds = Object.freeze(
    sources.filter(eligibleReplicationSource).map(({ sourceId }) => sourceId),
  );
  const available = eligibleSourceIds.length > 0;
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      availability: available
        ? ("AVAILABLE" as const)
        : ("UNAVAILABLE" as const),
      replicationStatus: available
        ? ("NOT_EXECUTED_PREREGISTRATION_REQUIRED" as const)
        : ("NOT_EXECUTED_SOURCE_UNAVAILABLE" as const),
      checkedSourceCount: sources.length,
      eligibleSourceIds,
    }),
  });
};

const invalidEvidence = (): ConfidenceQuantileSampleSizeResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "INVALID_CONFIDENCE_QUANTILE_SAMPLE_SIZE_EVIDENCE" as const,
    }),
  });

const observationKey = (
  observation: Pick<
    ConfidenceQuantileSampleSizeObservation,
    "populationId" | "runKey" | "strategyId"
  >,
): string =>
  `${observation.populationId}:${observation.runKey}:${observation.strategyId}`;

const expectedObservationKeys = (): ReadonlySet<string> =>
  new Set(
    CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS.flatMap((populationId) =>
      CONFIDENCE_QUANTILE_SAMPLE_SIZE_EXPECTED_RUN_KEYS[populationId].flatMap(
        (runKey) =>
          STRATEGY_IDS.map((strategyId) =>
            observationKey({ populationId, runKey, strategyId }),
          ),
      ),
    ),
  );

const validObservation = (
  observation: ConfidenceQuantileSampleSizeObservation,
): boolean =>
  CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS.some(
    (populationId) => populationId === observation.populationId,
  ) &&
  STRATEGY_IDS.some((strategyId) => strategyId === observation.strategyId) &&
  Number.isSafeInteger(observation.activeSignalCount) &&
  observation.activeSignalCount >= 0 &&
  Array.isArray(observation.requestedNotionalSamples) &&
  observation.requestedNotionalSamples.length ===
    observation.activeSignalCount &&
  observation.requestedNotionalSamples.every(
    (value) => Number.isFinite(value) && value > 0,
  );

const validProtocol = (
  protocol: ConfidenceQuantileSampleSizeProtocolEvidence,
): boolean =>
  protocol !== null &&
  typeof protocol === "object" &&
  protocol.selectedEstimator ===
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator &&
  protocol.medianEstimator ===
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.medianEstimator &&
  protocol.probability ===
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability &&
  protocol.maxP95RequestedNotional ===
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional &&
  protocol.maxP95ToMedianRatio ===
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio;

const toCase = (
  observation: ConfidenceQuantileSampleSizeObservation,
): ConfidenceQuantileSampleSizeCase | null => {
  const position = classifyConfidenceQuantileRankResolution(
    observation.activeSignalCount,
  );
  if (position === null) return null;
  if (observation.activeSignalCount === 0) {
    return Object.freeze({
      populationId: observation.populationId,
      runKey: observation.runKey,
      strategyId: observation.strategyId,
      activeSignalCount: observation.activeSignalCount,
      ...position,
      medianRequestedNotional: null,
      p95RequestedNotionalByEstimator: Object.freeze({
        LOWER: null,
        NEAREST_RANK: null,
        HIGHER: null,
      }),
      selectedP95RequestedNotional: null,
      selectedP95ToMedianRatio: null,
      selectedAbsoluteBreach: false,
      selectedRatioBreach: false,
      discreteP95SpreadUsd: null,
      discreteP95SpreadToMedian: null,
      discreteVerdictDisagreement: false,
    });
  }

  const medianResult = estimateQuantile(
    observation.requestedNotionalSamples,
    0.5,
    CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.medianEstimator,
  );
  if (!medianResult.ok || medianResult.value === null || medianResult.value <= 0) {
    return null;
  }
  const median = medianResult.value;
  const entries = CONFIDENCE_QUANTILE_DISCRETE_ESTIMATORS.map((estimator) => {
    const result = estimateQuantile(
      observation.requestedNotionalSamples,
      CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.probability,
      estimator,
    );
    return result.ok && result.value !== null
      ? ([estimator, result.value] as const)
      : null;
  });
  if (entries.some((entry) => entry === null)) return null;
  const p95ByEstimator = Object.freeze(
    Object.fromEntries(entries.filter((entry) => entry !== null)),
  ) as Readonly<Record<ConfidenceQuantileDiscreteEstimator, number>>;
  const selectedP95 = p95ByEstimator.NEAREST_RANK;
  const selectedRatio = selectedP95 / median;
  const values = Object.values(p95ByEstimator);
  const spread = Math.max(...values) - Math.min(...values);
  const estimatorVerdicts = new Set(
    values.map(
      (p95) =>
        p95 <=
          CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional &&
        p95 / median <=
          CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio,
    ),
  );

  return Object.freeze({
    populationId: observation.populationId,
    runKey: observation.runKey,
    strategyId: observation.strategyId,
    activeSignalCount: observation.activeSignalCount,
    ...position,
    medianRequestedNotional: median,
    p95RequestedNotionalByEstimator: p95ByEstimator,
    selectedP95RequestedNotional: selectedP95,
    selectedP95ToMedianRatio: selectedRatio,
    selectedAbsoluteBreach:
      selectedP95 >
      CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional,
    selectedRatioBreach:
      selectedRatio >
      CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio,
    discreteP95SpreadUsd: spread,
    discreteP95SpreadToMedian: spread / median,
    discreteVerdictDisagreement: estimatorVerdicts.size > 1,
  });
};

const maximumOrNull = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.max(...values);

const minimumOrNull = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);

const summarizeCases = (
  cases: readonly ConfidenceQuantileSampleSizeCase[],
): readonly ConfidenceQuantileSampleSizeSummary[] =>
  Object.freeze(
    CONFIDENCE_QUANTILE_SAMPLE_SIZE_POPULATIONS.flatMap((populationId) =>
      CONFIDENCE_QUANTILE_RANK_RESOLUTIONS.map((resolution) => {
        const selectedCases = cases.filter(
          (item) =>
            item.populationId === populationId && item.resolution === resolution,
        );
        const activeCases = selectedCases.filter(
          ({ activeSignalCount }) => activeSignalCount > 0,
        );
        return Object.freeze({
          populationId,
          resolution,
          caseCount: selectedCases.length,
          activeCaseCount: activeCases.length,
          minActiveSignalCount: minimumOrNull(
            activeCases.map(({ activeSignalCount }) => activeSignalCount),
          ),
          maxActiveSignalCount: maximumOrNull(
            activeCases.map(({ activeSignalCount }) => activeSignalCount),
          ),
          selectedAbsoluteBreachCount: selectedCases.filter(
            ({ selectedAbsoluteBreach }) => selectedAbsoluteBreach,
          ).length,
          selectedRatioBreachCount: selectedCases.filter(
            ({ selectedRatioBreach }) => selectedRatioBreach,
          ).length,
          discreteVerdictDisagreementCount: selectedCases.filter(
            ({ discreteVerdictDisagreement }) => discreteVerdictDisagreement,
          ).length,
          maxDiscreteP95SpreadUsd: maximumOrNull(
            activeCases.flatMap(({ discreteP95SpreadUsd }) =>
              discreteP95SpreadUsd === null ? [] : [discreteP95SpreadUsd],
            ),
          ),
          maxDiscreteP95SpreadToMedian: maximumOrNull(
            activeCases.flatMap(({ discreteP95SpreadToMedian }) =>
              discreteP95SpreadToMedian === null
                ? []
                : [discreteP95SpreadToMedian],
            ),
          ),
        });
      }),
    ),
  );

export const assessConfidenceQuantileSampleSizeAudit = (
  observations: readonly ConfidenceQuantileSampleSizeObservation[],
  protocol: ConfidenceQuantileSampleSizeProtocolEvidence,
): ConfidenceQuantileSampleSizeResult => {
  if (!Array.isArray(observations) || !validProtocol(protocol)) {
    return invalidEvidence();
  }
  const expectedKeys = expectedObservationKeys();
  const actualKeys = observations.map(observationKey);
  if (
    observations.length !== expectedKeys.size ||
    observations.some((observation) => !validObservation(observation)) ||
    new Set(actualKeys).size !== actualKeys.length ||
    actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    return invalidEvidence();
  }
  const cases = observations.map(toCase);
  if (cases.some((item) => item === null)) return invalidEvidence();
  const validCases = cases.filter((item) => item !== null);

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      status: "RESEARCH_ONLY" as const,
      selectedEstimator:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.selectedEstimator,
      maxP95RequestedNotional:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95RequestedNotional,
      maxP95ToMedianRatio:
        CONFIDENCE_QUANTILE_SENSITIVITY_POLICY.maxP95ToMedianRatio,
      liveAuthorization: false as const,
      liquidityValidated: false as const,
      alphaValidated: false as const,
      cases: Object.freeze(validCases),
      summaries: summarizeCases(validCases),
    }),
  });
};
