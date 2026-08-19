WITH source_artifact AS (
  SELECT json(readfile(
    'packages/backtest/.artifacts/studies/confidence-quantile-sample-size-audit-XTZ-ZEC-GRT-MANA-2022-2026.json'
  )) AS document
), disagreement_cases AS (
  SELECT
    json_extract(audit_case.value, '$.populationId') AS population,
    json_extract(audit_case.value, '$.runKey') AS run,
    json_extract(audit_case.value, '$.strategyId') AS strategy,
    json_extract(audit_case.value, '$.activeSignalCount') AS n,
    json_extract(audit_case.value, '$.rank') AS rank,
    json_extract(audit_case.value, '$.observationsAboveRank') AS observationsAboveRank,
    json_extract(audit_case.value, '$.resolution') AS resolution,
    json_extract(audit_case.value, '$.medianRequestedNotional') AS median,
    json_extract(audit_case.value, '$.p95RequestedNotionalByEstimator.LOWER') AS lowerP95,
    json_extract(audit_case.value, '$.p95RequestedNotionalByEstimator.NEAREST_RANK') AS nearestP95,
    json_extract(audit_case.value, '$.p95RequestedNotionalByEstimator.HIGHER') AS higherP95,
    json_extract(audit_case.value, '$.selectedP95ToMedianRatio') AS nearestRatio,
    json_extract(audit_case.value, '$.discreteP95SpreadUsd') AS spreadUsd,
    json_extract(audit_case.value, '$.selectedAbsoluteBreach') AS absoluteBreach,
    json_extract(audit_case.value, '$.selectedRatioBreach') AS ratioBreach
  FROM source_artifact
  JOIN json_each(source_artifact.document, '$.audit.cases') AS audit_case
  WHERE json_extract(audit_case.value, '$.discreteVerdictDisagreement') = 1
)
SELECT disagreement_cases.*
FROM disagreement_cases
CROSS JOIN source_artifact
WHERE json_extract(source_artifact.document, '$.status') = 'RESEARCH_ONLY'
  AND json_extract(source_artifact.document, '$.audit.status') = 'RESEARCH_ONLY'
ORDER BY nearestRatio DESC;
