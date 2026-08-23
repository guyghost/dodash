# Revue — Walk-forward sizing par calibration v1

Verdict : APPROUVÉ AVEC CORRECTIONS
Date : 2026-08-22
Revue de : `models/confidence-sizing-walkforward.md`

## Vérifications effectuées (contre le code réel)

1. **Indépendance prix de la porte notional** — chaîne confirmée :
   `suite.ts` L134-136 emboîte `withConfidenceCalibration(
   withTargetSignalNotional(strategy, target))` (calibration à
   l'extérieur) ; `resolveTargetSignalQuantity`
   (models/signal-sizing.ts L14-27) fait `suggestedSize =
   targetSignalNotional / referencePrice` ; `requestedNotional =
   suggestedSize × confiance_calibrée × referencePrice`
   (models/backtest-diagnostics.ts L158-161) = `target × c^k`.
   La porte [100, 400] est bien comparable entre 2016 ($600/BTC)
   et 2026 ($60 000+/BTC). ✔️
2. **Garde-fou données** — `loadCoinbaseHistoricalDataset`
   (coinbase-history.ts L203-211) exige exactement `candleCount`
   candles contiguës sinon `INCOMPLETE_HISTORICAL_DATA` : une année
   trouée élimine les folds associés, jamais comblée. Le protocole
   §3 (« une donnée manquante élimine le fold ») est donc garanti
   par le loader lui-même. ✔️
3. **Diagnostics par scénario** — `BacktestScenarioSummary.diagnostics`
   (suite.ts L71, rempli L299) expose via `summarizeBacktestDiagnostics`
   (models/backtest-diagnostics.ts) : par stratégie,
   `requestedNotional` en distribution (médiane calculable) et
   `activeSignalCount` (L144-162) ; globalement `capRate` (L182) et
   `riskRejectionRate` (L185). Les colonnes d'information du §3 sont
   disponibles sans `includeDiagnosticSamples`. ✔️
4. **WF2 baseline** — les valeurs de référence (IDENTITY = bull
   +0,27 % dd 2,93 % ; bear +3,63 % dd 3,37 %) correspondent à
   `confidence-sizing.md` §5 (mesures bit-identiques UNSET/IDENTITY). ✔️
5. **Comptage des runs** — 10 fenêtres × 4 profils = 40 runs ;
   folds = 9 ; contamination : fenêtres 2023→24 (bull, folds 7 test /
   8 train) et 2025→26 (bear, fold 9 test) ; folds propres 1-6.
   Recalculé indépendamment : exact. ✔️

## Corrections appliquées au modèle

1. **§3 divergence assumée avec le sélecteur déployé** — le modèle
   initial décrivait la règle du train comme « généralisation de
   `selectConfidenceCalibrationProfile` » : inexact. La fonction
   déployée (models/confidence-calibration.ts L172-250) sélectionne
   le **premier éligible** dans l'ordre de préférence [IDENTITY,
   HALF, THIRD, QUARTER] (donc préfère le moins agressif) et impose
   en plus capRate = 0, riskRejectionRate = 0, activeSignalCount > 0.
   Correction : la règle du walk-forward est celle du cycle sizing
   (portes CS4 + argmax return), la divergence est documentée, et
   capRate/riskRejectionRate deviennent des colonnes d'information
   bloquantes pour le déploiement.
2. **§3 référence des colonnes** — précision des sources exactes
   (backtest-diagnostics.ts L182/185) pour capRate et
   riskRejectionRate.

## Risques acceptés

- **Petit échantillon de folds** — 6 folds propres, critères en
  majorité (≥ 4/6) : puissance statistique faible, mais c'est la
  limite des données quotidiennes exploitables ; le protocole
  préfère l'honnêteté (contamination marquée) au gonflement artificiel.
- **Régimes non représentés** — les années 2016-2022 couvrent bear
  (2017→18, 2021→22), range (2019→20) et bull (2020→21) ; aucun fold
  propre ne reproduit exactement le couple bull/bear de la sélection
  d'origine — c'est précisément le but (généralisation).
- **Fenêtres chevauchantes** — test du fold i = train du fold i+1 :
  les folds ne sont pas indépendants entre eux (origine glissante
  standard) ; les critères en majorité mitigen mais n'éliminent pas
  cette dépendance.

## Checklist

- [x] États/transitions : aucun nouveau (campagne de mesure pure)
- [x] Effets de bord : aucun hors lecture API + mesure
- [x] Règle de sélection déterministe, fonction pure, spécifiée avant mesure
- [x] Critères a priori définis avant mesure (W1-W3, verdicts)
- [x] Contamination identifiée et exclue des critères
- [x] Aucune transition pilotée par texte libre / LLM
