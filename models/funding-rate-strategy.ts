/**
 * Constantes figées du seuil d'entrée de la stratégie funding-trend
 * (models/funding-rate-strategy.md §5, amendement dao #38).
 *
 * VARIANT IN-SAMPLE — NON VALIDÉ OUT-OF-SAMPLE (INV-F9) : la valeur est
 * dérivée une seule fois du dataset campagne-1 (fixtures dao30, fenêtre
 * close [2025-09-01, 2026-09-01)), AVANT tout rejeu au nouveau seuil
 * (C3). La validation hors-échantillon reste l'objet du protocole #35
 * (EN ATTENTE), qui porte ses propres seuils figés — aucun recalibrage
 * de celui-ci (INV-C7 v2). Toute activation runtime/paper reste déniée
 * par défaut (DEFAULT_REGIME_PERMISSIONS inchangé : `funding-trend`
 * déniée dans les 3 régimes — C1) et ne peut venir que d'une proposition
 * séparée.
 */

/** Percentile figé de la règle de calibration §5 (amendement dao #38). */
export const FUNDING_TREND_THRESHOLD_PERCENTILE = 75 as const;

/**
 * Seuil d'entrée figé : p75 de `|fundingAvg|` (SMA 72 jours causale,
 * FUNDING_AVG_PERIOD) sur les 294 jours de décision du dataset campagne-1
 * (`packages/backtest/fixtures/dao30-*`), méthode du rang le plus proche
 * (`h = ⌈p/100 × N⌉`, sans interpolation) — valeur identique à
 * `distributionAbsFundingAvg.p75` de
 * `models/funding-edge-campaign-v2.annexe-calibration.json` (artefact
 * commité #35 ; le rejeu comparatif re-vérifie l'égalité, tout écart est
 * fatal). Remplace la valeur v1 `5e-5` (choix a priori #27, jamais
 * atteint : 0/294 jours traversés in-sample, 0 trade sur H12).
 */
export const FUNDING_TREND_ENTER_THRESHOLD = 0.0000088750099537037;
