import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessConfidenceQuantileSampleSizeAudit,
  assessLessCorrelatedReplicationSources,
} from "@dodash/models";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
const INPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json",
);
const OUTPUT_PATH = resolve(
  SCRIPT_DIRECTORY,
  "../.artifacts/studies/confidence-quantile-sample-size-audit-XTZ-ZEC-GRT-MANA-2022-2026.json",
);
const TEMPORARY_OUTPUT_PATH = `${OUTPUT_PATH}.${process.pid}.tmp`;
const INSPECTED_SOURCE_PATHS = Object.freeze([
  resolve(REPOSITORY_ROOT, "packages/backtest/src/coinbase-history.ts"),
  resolve(REPOSITORY_ROOT, "apps/mcp-market-data/src/coinbase.ts"),
]);
const FROZEN_PROTOCOL = Object.freeze({
  selectedEstimator: "NEAREST_RANK",
  medianEstimator: "LINEAR_R7",
  probability: 0.95,
  maxP95RequestedNotional: 600,
  maxP95ToMedianRatio: 2,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const inspectLocalSources = async () => {
  const sourceFiles = [];
  for (const path of INSPECTED_SOURCE_PATHS) {
    await access(path);
    const content = await readFile(path);
    sourceFiles.push(
      Object.freeze({
        path: relative(REPOSITORY_ROOT, path),
        sha256: sha256(content),
      }),
    );
  }
  const capabilities = Object.freeze([
    Object.freeze({
      sourceId: "coinbase-advanced-trade",
      assetUniverse: "CRYPTO_SPOT",
      configured: true,
      accessAvailable: true,
      timeframes: Object.freeze(["ONE_DAY", "SIX_HOUR"]),
      completeFoldCoverage: true,
      ohlcvAvailable: true,
      timestampsDocumented: true,
      adjustmentPolicyDocumented: false,
      executionComparable: true,
    }),
  ]);
  const assessment = assessLessCorrelatedReplicationSources(capabilities);
  if (!assessment.ok) throw new Error(JSON.stringify(assessment.error));
  return Object.freeze({
    discoveryMethod:
      "workspace adapter inventory plus capability assessment from the frozen model",
    sourceFiles: Object.freeze(sourceFiles),
    capabilities,
    assessment: assessment.value,
  });
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireRecord = (value, context) => {
  if (!isRecord(value)) throw new Error(`INVALID_INPUT:${context}`);
  return value;
};

const requireArray = (value, context) => {
  if (!Array.isArray(value)) throw new Error(`INVALID_INPUT:${context}`);
  return value;
};

const validateFrozenProtocol = (artifact) => {
  const protocol = requireRecord(artifact.protocol, "protocol");
  if (
    artifact.status !== "RESEARCH_ONLY" ||
    artifact.selectedEstimator !== FROZEN_PROTOCOL.selectedEstimator ||
    artifact.timeframe !== "ONE_DAY" ||
    artifact.executionTimeframe !== "SIX_HOUR" ||
    artifact.frozenProfile !== "POWER_THIRD" ||
    protocol.selectedEstimator !== FROZEN_PROTOCOL.selectedEstimator ||
    protocol.medianEstimator !== FROZEN_PROTOCOL.medianEstimator ||
    protocol.probability !== FROZEN_PROTOCOL.probability ||
    protocol.maxP95RequestedNotionalUsd !==
      FROZEN_PROTOCOL.maxP95RequestedNotional ||
    protocol.maxP95ToMedianRatio !== FROZEN_PROTOCOL.maxP95ToMedianRatio
  ) {
    throw new Error("FROZEN_PROTOCOL_MISMATCH");
  }
};

const observationsFrom = (artifact) => {
  const evidence = requireRecord(artifact.evidence, "evidence");
  return ["REFERENCE", "EXTERNAL"].flatMap((populationId) => {
    const population = requireRecord(evidence[populationId.toLowerCase()], populationId);
    if (population.id !== populationId) {
      throw new Error(`INVALID_INPUT:${populationId}:id`);
    }
    return requireArray(population.observations, `${populationId}:observations`)
      .filter((observation) => observation?.profile === "POWER_THIRD")
      .map((observation) =>
        Object.freeze({
          populationId,
          runKey: observation.runKey,
          strategyId: observation.strategyId,
          activeSignalCount: observation.activeSignalCount,
          requestedNotionalSamples: observation.requestedNotionalSamples,
        }),
      );
  });
};

const upstreamSelectedCounts = (artifact, populationId) => {
  const evidence = requireRecord(artifact.evidence, "evidence");
  const population = requireRecord(
    evidence[populationId.toLowerCase()],
    populationId,
  );
  const assessment = requireRecord(population.assessment, `${populationId}:assessment`);
  const estimators = requireArray(
    assessment.estimators,
    `${populationId}:estimators`,
  );
  const selected = estimators.find(
    (item) => item?.estimator === FROZEN_PROTOCOL.selectedEstimator,
  );
  if (!isRecord(selected)) {
    throw new Error(`INVALID_INPUT:${populationId}:selected-estimator`);
  }
  return Object.freeze({
    absoluteBreachCount: selected.absoluteBreachCount,
    ratioBreachCount: selected.ratioBreachCount,
    verdict: assessment.selectedVerdict,
  });
};

const reconcileSelectedCounts = (artifact, assessment) => {
  const reconciliation = {};
  for (const populationId of ["REFERENCE", "EXTERNAL"]) {
    const upstream = upstreamSelectedCounts(artifact, populationId);
    const cases = assessment.cases.filter(
      (item) => item.populationId === populationId,
    );
    const recomputed = Object.freeze({
      absoluteBreachCount: cases.filter(
        ({ selectedAbsoluteBreach }) => selectedAbsoluteBreach,
      ).length,
      ratioBreachCount: cases.filter(
        ({ selectedRatioBreach }) => selectedRatioBreach,
      ).length,
    });
    if (
      recomputed.absoluteBreachCount !== upstream.absoluteBreachCount ||
      recomputed.ratioBreachCount !== upstream.ratioBreachCount
    ) {
      throw new Error(`SELECTED_COUNT_RECONCILIATION_FAILED:${populationId}`);
    }
    reconciliation[populationId] = Object.freeze({ upstream, recomputed });
  }
  return Object.freeze(reconciliation);
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
  const inputRaw = await readFile(INPUT_PATH, "utf8");
  const inputArtifact = requireRecord(JSON.parse(inputRaw), "root");
  validateFrozenProtocol(inputArtifact);
  const sourceAudit = await inspectLocalSources();
  const result = assessConfidenceQuantileSampleSizeAudit(
    observationsFrom(inputArtifact),
    FROZEN_PROTOCOL,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const selectedCountReconciliation = reconcileSelectedCounts(
    inputArtifact,
    result.value,
  );
  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    status: "RESEARCH_ONLY",
    study: "CONFIDENCE_QUANTILE_SAMPLE_SIZE_AUDIT",
    upstream: Object.freeze({
      artifact: relative(REPOSITORY_ROOT, INPUT_PATH),
      sha256: sha256(inputRaw),
      generatedAt: inputArtifact.generatedAt,
      referenceSensitivityVerdict: inputArtifact.sensitivityVerdict,
      externalSelectedVerdict: inputArtifact.verdict,
      selectedCountReconciliation,
    }),
    policy: FROZEN_PROTOCOL,
    sourceAudit,
    crossUniverseReplication: Object.freeze({
      status: sourceAudit.assessment.replicationStatus,
      executed: false,
      products: null,
      reason:
        "no configured non-crypto adapter provides comparable ONE_DAY and SIX_HOUR history in this workspace",
    }),
    audit: result.value,
    interpretationLimits: Object.freeze({
      previousVerdictsChanged: false,
      liveAuthorization: false,
      liquidityValidated: false,
      alphaValidated: false,
      statement:
        "requested-notional scale only; this audit does not establish liquidity, alpha or live readiness",
    }),
  });
  await writeArtifact(artifact);
  console.log(`source=${sourceAudit.assessment.availability}`);
  console.log(`replication=${sourceAudit.assessment.replicationStatus}`);
  console.log(`cases=${result.value.cases.length}`);
  console.log(`artifact=${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
