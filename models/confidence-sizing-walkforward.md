# Walk-forward sizing par calibration v1

Statut : REVU — APPROUVÉ AVEC CORRECTIONS
Date : 2026-08-22
Prérequis : `confidence-sizing.md` (grille in-sample : POWER_QUARTER
composite +9,20 %, toutes portes CS4 ✔), `confidence-calibration.ts`
(portes de sélection), `regime-exit.md` (V1 champion exits 300/600).

## 1. Problème

POWER_QUARTER a été sélectionné sur deux fenêtres (bull 2023-08→2024-08,
bear 2025-08→2026-08) choisies a priori puis mesurées. Ces deux fenêtres
sont désormais **contaminées** : elles ont servi à la sélection. Avant de
déclarer QUARTER déployé, il faut établir que (a) la règle de sélection
le choisit aussi sur des années jamais vues, et (b) le profil sélectionné
bat IDENTITY en out-of-sample. Sans cela, le doublement du composite
(+3,90 % → +9,20 %) peut être un artefait de sélection sur deux points.

Aucun changement de comportement déployé : campagne de mesure, même
nature que `confidence-sizing.md`.

## 2. Faits établis utilisés

- `resolveTargetSignalQuantity` (models/signal-sizing.ts L14-27) :
  `suggestedSize = targetSignalNotional / referencePrice`, donc
  `requestedNotional = suggestedSize × c^k × referencePrice =
  targetSignalNotional × c^k` — **indépendant du niveau de prix**.
  La porte notional médiane ∈ [100, 400] reste comparable sur des
  années où BTC vaut $600 comme $60 000.
- Données Coinbase ONE_DAY disponibles et complètes au moins jusqu'à
  2016 (sonde 2026-08-22 : 5/5 candles sur fenêtres test 2016, 2018,
  2020, 2021, 2022). Le loader rejette toute fenêtre incomplète
  (`INCOMPLETE_HISTORICAL_DATA`) — une donnée manquante élimine le
  fold, jamais ne le comble.

## 3. Protocole W (walk-forward à origine glissante annuelle)

- Fenêtres calendaires Y-08-21 → (Y+1)-08-21, pour Y ∈
  {2016, …, 2025} : dix fenêtres contiguës.
- Chaque fenêtre est mesurée avec les 4 profils
  {IDENTITY, POWER_HALF, POWER_THIRD, POWER_QUARTER} sous la
  configuration V1 **bit-identique** à la grille sizing (exits
  REGIME_CONDITIONAL bull NONE / autres FIXED 300/600, gate
  EMA_THRESHOLD 100/5/3, fee 6 bps, slippage 2 bps, capital 10 000,
  targetSignalNotional 1 000) — seul `confidenceCalibration` varie.
- Fold i = (train : fenêtre Y_i, test : fenêtre Y_{i+1}) pour
  Y_i ∈ {2016, …, 2024} : neuf folds. Chaque année sert à la fois de
  test (fold précédent) et de train (fold suivant) — 40 runs uniques.
- **Règle de sélection par train** (déterministe, fonction pure) :
  1. éligible = portes tenues sur le train : notion médiane
     ∈ [100, 400] par stratégie calibrée (ema-cross, breakout),
     dd ≤ 10 %, turnover ≤ 10, feeRate ≤ 1 % ;
  2. sélectionné = profil éligible au return maximal sur le train ;
  3. si aucun éligible → IDENTITY (défaut conservateur).

  Cette règle est celle du cycle sizing (§4 de `confidence-sizing.md` :
  portes CS4 + argmax). Elle **diverge assumément** de la fonction
  déployée `selectConfidenceCalibrationProfile`
  (models/confidence-calibration.ts L172-250), qui sélectionne le
  **premier éligible** dans l'ordre de préférence [IDENTITY, HALF,
  THIRD, QUARTER] et ajoute les portes `capRate = 0`,
  `riskRejectionRate = 0` et `activeSignalCount > 0` (raisons
  ALLOCATION_CAPPED, RISK_REDUCED, INACTIVE_RUN). Le walk-forward
  teste la procédure de décision qui a produit QUARTER (argmax),
  pas le sélecteur de déploiement. En conséquence, `capRate` et
  `riskRejectionRate` par run sont **consignés comme colonnes
  d'information** (exposés par scénario via
  `summarizeBacktestDiagnostics`, models/backtest-diagnostics.ts
  L182/185) : si QUARTER présente capRate > 0 ou riskRejection > 0
  sur les fenêtres, le déploiement via le sélecteur déployé
  l'exclurait — à traiter avant flag CLI.
- **Contamination** (fenêtres ayant servi à la sélection QUARTER
  d'origine) : bull = fenêtre 2023→24, bear = fenêtre 2025→26.
  Folds **propres** (ni train ni test contaminé) : folds 1-6, tests
  2017→18 … 2022→23. Folds 7-9 touchent une fenêtre contaminée —
  mesurés et consignés mais exclus des critères.

## 4. Invariants

| # | Invariant |
| --- | --- |
| WF1 | Configuration identique à la grille sizing, seul `confidenceCalibration` varie — toute divergence invalide la comparaison |
| WF2 | Contrôle de non-dérive : IDENTITY sur 2023→24 et 2025→26 doit reproduire la baseline V1 bit pour bit (+0,27 % dd 2,93 % ; +3,63 % dd 3,37 %) |
| WF3 | La sélection par train est calculée par une fonction pure spécifiée en §3 — aucune décision humaine ou LLM dans la boucle |
| WF4 | Les critères a priori portent exclusivement sur les six folds propres ; les folds contaminés sont consignés pour information |

## 5. Critères a priori (évalués sur folds propres uniquement)

1. **W1 — stabilité** : QUARTER est le profil sélectionné sur au
   moins 4 des 6 trains propres.
2. **W2 — performance OOS** : sur les folds propres, le sélectionné
   bat IDENTITY en return test dans au moins 4 folds sur 6, et le
   return médian (sélectionné − IDENTITY) sur test est > 0.
3. **W3 — sécurité OOS** : sur les tests propres, le sélectionné ne
   viole jamais dd > 10 %, turnover > 10, ni feeRate > 1 %.

Verdicts possibles :
- W1 ∧ W2 ∧ W3 → **VALIDÉ** : QUARTER déclaré déployable (flag CLI
  `--confidence-calibration POWER_QUARTER`).
- W1 ∧ ¬W2 → sélection stable mais pas de transfert OOS : **DÉCLASSÉ**,
  V1/IDENTITY reste champion, QUARTER archivé avec causes.
- ¬W1 → la sélection in-sample était non robuste : **DÉCLASSÉ**.
- W3 violé n'importe où → **DÉCLASSÉ** quoi qu'il arrive (sécurité
  avant performance).

## 6. Hors périmètre

- Ré-optimiser les exits ou le gate par fold (un seul levier à la
  fois ; exits gelés en V1).
- Fenêtres intra-annuelles (pas 3/6 mois) — coût de calcul ×4 pour
  information redondante à ce stade.
- Calibration de rsi-reversion (hors `CalibratedStrategyId`).
- Timeframes autres que ONE_DAY.
