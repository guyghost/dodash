-- DuckDB source projection for the technical report. The cross join makes the
-- reviewed constants fail closed when the canonical study artifact is absent.
WITH source_artifact AS (
  SELECT verdict, sensitivityVerdict, selectedEstimator
  FROM read_json_auto(
    'packages/backtest/.artifacts/studies/confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json'
  )
), headline AS (
  SELECT *
  FROM (VALUES
    (1.9298100090800627, 2.0, 553.7022833779773, 600.0, 0, 16, 1, 4)
  ) AS values_table(
    externalMaxRatio,
    ratioLimit,
    externalMaxP95Usd,
    p95LimitUsd,
    externalBreachCases,
    externalEvaluatedCases,
    referencePassingEstimators,
    comparedEstimators
  )
)
SELECT headline.*, source_artifact.verdict, source_artifact.selectedEstimator
FROM headline
CROSS JOIN source_artifact;

WITH source_artifact AS (
  SELECT verdict
  FROM read_json_auto(
    'packages/backtest/.artifacts/studies/confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json'
  )
), estimator_comparison AS (
  SELECT *
  FROM (VALUES
    ('XTZ/ZEC', 'LINEAR_R7', 'TAIL_NOT_CONFIRMED', 2.0053863238712353, 570.0168667618947, 0, 1, false),
    ('XTZ/ZEC', 'NEAREST_RANK', 'TAIL_NOT_CONFIRMED', 2.4897201654862150, 675.9803870872818, 1, 3, false),
    ('XTZ/ZEC', 'LOWER', 'TAIL_CONFIRMED', 1.8439417099995750, 569.6996451925954, 0, 0, true),
    ('XTZ/ZEC', 'HIGHER', 'TAIL_NOT_CONFIRMED', 2.4897201654862150, 675.9803870872818, 1, 3, false),
    ('GRT/MANA', 'LINEAR_R7', 'TAIL_CONFIRMED', 1.8797412595980474, 543.2910556901403, 0, 0, true),
    ('GRT/MANA', 'NEAREST_RANK', 'TAIL_CONFIRMED', 1.9298100090800627, 553.7022833779773, 0, 0, true),
    ('GRT/MANA', 'LOWER', 'TAIL_CONFIRMED', 1.8387759191127622, 523.9559185555861, 0, 0, true),
    ('GRT/MANA', 'HIGHER', 'TAIL_CONFIRMED', 1.9298100090800627, 553.7022833779773, 0, 0, true)
  ) AS values_table(
    population,
    estimator,
    estimatorVerdict,
    maxRatio,
    maxP95Usd,
    absoluteBreaches,
    ratioBreaches,
    passing
  )
)
SELECT estimator_comparison.*
FROM estimator_comparison
CROSS JOIN source_artifact
ORDER BY population DESC, estimator;

WITH source_artifact AS (
  SELECT verdict
  FROM read_json_auto(
    'packages/backtest/.artifacts/studies/confidence-quantile-sensitivity-XTZ-ZEC-GRT-MANA-2022-2026.json'
  )
), tightest_external AS (
  SELECT *
  FROM (VALUES
    ('MANA-USD:2024-2025', 'ema-cross', 12, 111.73455238412589, 215.62645755096673, 1.9298100090800627, 0.0701899909199373, 384.37354244903327),
    ('MANA-USD:2024-2025', 'breakout', 28, 281.99169797315244, 507.18512066855680, 1.7985817466046263, 0.2014182533953737, 92.81487933144320),
    ('GRT-USD:2024-2025', 'ema-cross', 10, 122.57402663724534, 219.75837802784693, 1.7928625179151220, 0.2071374820848781, 380.24162197215310),
    ('GRT-USD:2022-2023', 'breakout', 28, 315.11680576911360, 553.70228337797730, 1.7571334604847306, 0.2428665395152694, 46.29771662202273),
    ('GRT-USD:2025-2026', 'ema-cross', 9, 114.66246812217085, 197.77946664560520, 1.7248840870482105, 0.2751159129517895, 402.22053335439480)
  ) AS values_table(
    runKey,
    strategy,
    activeSignals,
    medianR7Usd,
    p95NearestRankUsd,
    ratio,
    ratioHeadroom,
    p95HeadroomUsd
  )
)
SELECT tightest_external.*
FROM tightest_external
CROSS JOIN source_artifact
ORDER BY ratio DESC;
