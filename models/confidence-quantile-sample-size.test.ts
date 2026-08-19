import { describe, expect, it } from "vitest";

import {
  assessConfidenceQuantileSampleSizeAudit,
  assessLessCorrelatedReplicationSources,
  classifyConfidenceQuantileRankResolution,
} from "./confidence-quantile-sample-size.js";

const EXPECTED_RUN_KEYS = Object.freeze({
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
const STRATEGIES = Object.freeze(["ema-cross", "breakout"] as const);
const FROZEN_PROTOCOL = Object.freeze({
  selectedEstimator: "NEAREST_RANK" as const,
  medianEstimator: "LINEAR_R7" as const,
  probability: 0.95,
  maxP95RequestedNotional: 600,
  maxP95ToMedianRatio: 2,
});

interface TestObservation {
  readonly populationId: "REFERENCE" | "EXTERNAL";
  readonly runKey: string;
  readonly strategyId: (typeof STRATEGIES)[number];
  readonly activeSignalCount: number;
  readonly requestedNotionalSamples: readonly number[];
}

const completeEvidence = (): TestObservation[] =>
  (Object.entries(EXPECTED_RUN_KEYS) as readonly [
    TestObservation["populationId"],
    readonly string[],
  ][]).flatMap(([populationId, runKeys]) =>
    runKeys.flatMap((runKey) =>
      STRATEGIES.map((strategyId) => ({
        populationId,
        runKey,
        strategyId,
        activeSignalCount: 10,
        requestedNotionalSamples: Array(10).fill(100) as readonly number[],
      })),
    ),
  );

describe("confidence quantile sample-size audit", () => {
  it("classe un p95 nearest-rank porté par le maximum", () => {
    expect(classifyConfidenceQuantileRankResolution(10)).toEqual({
      rank: 10,
      observationsAboveRank: 0,
      resolution: "MAXIMUM",
    });
  });

  it("dérive les classes aux frontières exactes du rang p95", () => {
    expect(classifyConfidenceQuantileRankResolution(0)).toEqual({
      rank: null,
      observationsAboveRank: 0,
      resolution: "NO_ACTIVE_SIGNALS",
    });
    expect(classifyConfidenceQuantileRankResolution(19)).toMatchObject({
      rank: 19,
      observationsAboveRank: 0,
      resolution: "MAXIMUM",
    });
    expect(classifyConfidenceQuantileRankResolution(20)).toMatchObject({
      rank: 19,
      observationsAboveRank: 1,
      resolution: "ONE_ABOVE",
    });
    expect(classifyConfidenceQuantileRankResolution(39)).toMatchObject({
      rank: 38,
      observationsAboveRank: 1,
      resolution: "ONE_ABOVE",
    });
    expect(classifyConfidenceQuantileRankResolution(40)).toMatchObject({
      rank: 38,
      observationsAboveRank: 2,
      resolution: "TWO_OR_MORE_ABOVE",
    });
  });

  it("refuse un compteur actif invalide", () => {
    expect(classifyConfidenceQuantileRankResolution(-1)).toBeNull();
    expect(classifyConfidenceQuantileRankResolution(1.5)).toBeNull();
    expect(
      classifyConfidenceQuantileRankResolution(Number.POSITIVE_INFINITY),
    ).toBeNull();
  });

  it("audite chaque case sans re-sélectionner nearest-rank", () => {
    expect(
      assessConfidenceQuantileSampleSizeAudit(
        completeEvidence(),
        FROZEN_PROTOCOL,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        status: "RESEARCH_ONLY",
        selectedEstimator: "NEAREST_RANK",
        maxP95RequestedNotional: 600,
        maxP95ToMedianRatio: 2,
        liveAuthorization: false,
        liquidityValidated: false,
        alphaValidated: false,
        cases: expect.arrayContaining([
          expect.objectContaining({
            populationId: "REFERENCE",
            runKey: "XTZ-USD:2022-2023",
            strategyId: "ema-cross",
            activeSignalCount: 10,
            rank: 10,
            observationsAboveRank: 0,
            resolution: "MAXIMUM",
            selectedP95RequestedNotional: 100,
            selectedP95ToMedianRatio: 1,
            selectedAbsoluteBreach: false,
            selectedRatioBreach: false,
            discreteP95SpreadUsd: 0,
            discreteP95SpreadToMedian: 0,
            discreteVerdictDisagreement: false,
          }),
        ]),
      },
    });
  });

  it("résume séparément la résolution et le désaccord des conventions discrètes", () => {
    const evidence = completeEvidence().map((item) =>
      item.populationId === "REFERENCE" &&
      item.runKey === "XTZ-USD:2022-2023" &&
      item.strategyId === "ema-cross"
        ? {
            ...item,
            activeSignalCount: 20,
            requestedNotionalSamples: [
              ...Array(19).fill(300),
              700,
            ] as readonly number[],
          }
        : item,
    );
    const result = assessConfidenceQuantileSampleSizeAudit(
      evidence,
      FROZEN_PROTOCOL,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          populationId: "REFERENCE",
          runKey: "XTZ-USD:2022-2023",
          strategyId: "ema-cross",
          activeSignalCount: 20,
          rank: 19,
          observationsAboveRank: 1,
          resolution: "ONE_ABOVE",
          p95RequestedNotionalByEstimator: {
            LOWER: 300,
            NEAREST_RANK: 300,
            HIGHER: 700,
          },
          selectedAbsoluteBreach: false,
          selectedRatioBreach: false,
          discreteP95SpreadUsd: 400,
          discreteP95SpreadToMedian: 4 / 3,
          discreteVerdictDisagreement: true,
        }),
      ]),
    );
    expect(result.value.summaries).toHaveLength(8);
    expect(result.value.summaries).toEqual(
      expect.arrayContaining([
        {
          populationId: "REFERENCE",
          resolution: "ONE_ABOVE",
          caseCount: 1,
          activeCaseCount: 1,
          minActiveSignalCount: 20,
          maxActiveSignalCount: 20,
          selectedAbsoluteBreachCount: 0,
          selectedRatioBreachCount: 0,
          discreteVerdictDisagreementCount: 1,
          maxDiscreteP95SpreadUsd: 400,
          maxDiscreteP95SpreadToMedian: 4 / 3,
        },
      ]),
    );
  });

  it("refuse toute modification de l’estimateur ou des bornes amont", () => {
    for (const protocol of [
      { ...FROZEN_PROTOCOL, selectedEstimator: "LOWER" },
      { ...FROZEN_PROTOCOL, maxP95RequestedNotional: 601 },
      { ...FROZEN_PROTOCOL, maxP95ToMedianRatio: 2.01 },
    ]) {
      expect(
        assessConfidenceQuantileSampleSizeAudit(
          completeEvidence(),
          protocol as typeof FROZEN_PROTOCOL,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "INVALID_CONFIDENCE_QUANTILE_SAMPLE_SIZE_EVIDENCE",
        },
      });
    }
  });

  it("n’assimile pas l’adapter Coinbase crypto à un univers moins corrélé", () => {
    expect(
      assessLessCorrelatedReplicationSources([
        {
          sourceId: "coinbase-history",
          assetUniverse: "CRYPTO_SPOT",
          configured: true,
          accessAvailable: true,
          timeframes: ["ONE_DAY", "SIX_HOUR"],
          completeFoldCoverage: true,
          ohlcvAvailable: true,
          timestampsDocumented: true,
          adjustmentPolicyDocumented: true,
          executionComparable: true,
        },
      ]),
    ).toEqual({
      ok: true,
      value: {
        availability: "UNAVAILABLE",
        replicationStatus: "NOT_EXECUTED_SOURCE_UNAVAILABLE",
        checkedSourceCount: 1,
        eligibleSourceIds: [],
      },
    });
  });

  it("accepte exactement 600 USD et un ratio de deux", () => {
    const evidence = completeEvidence().map((item) =>
      item.populationId === "EXTERNAL" &&
      item.runKey === "GRT-USD:2022-2023" &&
      item.strategyId === "breakout"
        ? {
            ...item,
            requestedNotionalSamples: [
              ...Array(9).fill(300),
              600,
            ] as readonly number[],
          }
        : item,
    );

    const result = assessConfidenceQuantileSampleSizeAudit(
      evidence,
      FROZEN_PROTOCOL,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          populationId: "EXTERNAL",
          runKey: "GRT-USD:2022-2023",
          strategyId: "breakout",
          selectedP95RequestedNotional: 600,
          selectedP95ToMedianRatio: 2,
          selectedAbsoluteBreach: false,
          selectedRatioBreach: false,
        }),
      ]),
    );
  });

  it("refuse une matrice absente, dupliquée ou incohérente", () => {
    const evidence = completeEvidence();
    const invalidLength = evidence.map((item, index) =>
      index === 0 ? { ...item, requestedNotionalSamples: [100] } : item,
    );
    const invalidValue = evidence.map((item, index) =>
      index === 0
        ? {
            ...item,
            requestedNotionalSamples: [
              ...item.requestedNotionalSamples.slice(0, -1),
              0,
            ],
          }
        : item,
    );

    for (const invalid of [
      evidence.slice(1),
      [...evidence.slice(0, -1), evidence[0] as TestObservation],
      invalidLength,
      invalidValue,
    ]) {
      expect(
        assessConfidenceQuantileSampleSizeAudit(
          invalid,
          FROZEN_PROTOCOL,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "INVALID_CONFIDENCE_QUANTILE_SAMPLE_SIZE_EVIDENCE",
        },
      });
    }
  });

  it("rend éligible seulement une source non crypto entièrement comparable", () => {
    expect(
      assessLessCorrelatedReplicationSources([
        {
          sourceId: "non-crypto-history",
          assetUniverse: "EQUITIES",
          configured: true,
          accessAvailable: true,
          timeframes: ["ONE_DAY", "SIX_HOUR"],
          completeFoldCoverage: true,
          ohlcvAvailable: true,
          timestampsDocumented: true,
          adjustmentPolicyDocumented: true,
          executionComparable: true,
        },
      ]),
    ).toEqual({
      ok: true,
      value: {
        availability: "AVAILABLE",
        replicationStatus: "NOT_EXECUTED_PREREGISTRATION_REQUIRED",
        checkedSourceCount: 1,
        eligibleSourceIds: ["non-crypto-history"],
      },
    });
  });
});
