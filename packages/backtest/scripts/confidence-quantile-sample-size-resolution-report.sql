WITH source_artifact AS (
  SELECT json(readfile(
    'packages/backtest/.artifacts/studies/confidence-quantile-sample-size-audit-XTZ-ZEC-GRT-MANA-2022-2026.json'
  )) AS document
), resolution_summary AS (
  SELECT
    json_extract(summary.value, '$.populationId') AS population,
    json_extract(summary.value, '$.resolution') AS resolution,
    json_extract(summary.value, '$.caseCount') AS caseCount,
    json_extract(summary.value, '$.discreteVerdictDisagreementCount') AS disagreementCount,
    json_extract(summary.value, '$.minActiveSignalCount') AS minN,
    json_extract(summary.value, '$.maxActiveSignalCount') AS maxN,
    json_extract(summary.value, '$.selectedAbsoluteBreachCount') AS absoluteBreaches,
    json_extract(summary.value, '$.selectedRatioBreachCount') AS ratioBreaches,
    json_extract(summary.value, '$.maxDiscreteP95SpreadUsd') AS maxSpreadUsd,
    json_extract(summary.value, '$.maxDiscreteP95SpreadToMedian') AS maxSpreadToMedian
  FROM source_artifact
  JOIN json_each(source_artifact.document, '$.audit.summaries') AS summary
  WHERE json_extract(summary.value, '$.caseCount') > 0
)
SELECT
  CASE
    WHEN population = 'REFERENCE' AND resolution = 'MAXIMUM' THEN 'Référence — maximum'
    WHEN population = 'REFERENCE' AND resolution = 'ONE_ABOVE' THEN 'Référence — 1 au-dessus'
    WHEN population = 'EXTERNAL' AND resolution = 'MAXIMUM' THEN 'Externe — maximum'
    WHEN population = 'EXTERNAL' AND resolution = 'ONE_ABOVE' THEN 'Externe — 1 au-dessus'
    WHEN population = 'EXTERNAL' AND resolution = 'TWO_OR_MORE_ABOVE' THEN 'Externe — ≥2 au-dessus'
    ELSE population || ' — ' || resolution
  END AS segment,
  resolution_summary.*
FROM resolution_summary
CROSS JOIN source_artifact
WHERE json_extract(source_artifact.document, '$.status') = 'RESEARCH_ONLY'
  AND json_extract(source_artifact.document, '$.policy.selectedEstimator') = 'NEAREST_RANK'
  AND json_extract(source_artifact.document, '$.policy.maxP95RequestedNotional') = 600
  AND json_extract(source_artifact.document, '$.policy.maxP95ToMedianRatio') = 2
ORDER BY
  CASE population WHEN 'REFERENCE' THEN 0 ELSE 1 END,
  CASE resolution
    WHEN 'MAXIMUM' THEN 0
    WHEN 'ONE_ABOVE' THEN 1
    ELSE 2
  END;
