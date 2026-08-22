# Walk-forward sizing par calibration v1

Statut : MESURÉ — DÉCLASSÉ (W1, W2, W3 échoués)
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

## 6. Résultats et verdict

Mesuré le 2026-08-22 (`scripts/confidence-sizing-walkforward.ts`,
40 runs, ~75 s chacun). WF2 **PASS** : IDENTITY 2023 +0,27 % dd
2,93 % et 2025 +3,63 % dd 3,37 % reproduits bit pour bit — la mesure
dérive de rien, le verdict porte sur la donnée.

Grille annuelle (return ensemble ; éligibilité au sens CS4) :

| année | IDENTITY | QUARTER | dd QUARTER | éligibles | sélectionné |
| --- | --- | --- | --- | --- | --- |
| 2016 | +2,35 % | +45,37 % | 20,05 % | aucun | IDENTITY |
| 2017 | +3,85 % | +69,05 % | 27,97 % | aucun | IDENTITY |
| 2018 | +3,48 % | +36,40 % | 19,55 % | aucun | IDENTITY |
| 2019 | −2,60 % | −4,87 % | 5,09 % | THIRD, QUARTER | THIRD |
| 2020 | +11,33 % | +130,47 % | 20,49 % | aucun | IDENTITY |
| 2021 | −5,81 % | −8,23 % | 9,46 % | THIRD | THIRD |
| 2022 | −1,03 % | −2,16 % | 3,46 % | THIRD, QUARTER | THIRD |
| 2023* | +0,27 % | +5,81 % | 7,39 % | THIRD, QUARTER | QUARTER |
| 2024 | +2,01 % | +5,86 % | 4,75 % | QUARTER | QUARTER |
| 2025* | +3,63 % | +3,39 % | 3,61 % | QUARTER | — |

\* fenêtre contaminée (servi à la sélection in-sample d'origine).

Folds propres (critères) : sélectionné vs IDENTITY en test —

| train | test | sélectionné | test sélectionné | test IDENTITY |
| --- | --- | --- | --- | --- |
| 2016 | 2017 | IDENTITY | +3,85 % | +3,85 % |
| 2017 | 2018 | IDENTITY | +3,48 % | +3,48 % |
| 2018 | 2019 | IDENTITY | −2,60 % | −2,60 % |
| 2019 | 2020 | THIRD | +101,27 % | +11,33 % |
| 2020 | 2021 | IDENTITY | −5,81 % | −5,81 % |
| 2021 | 2022 | THIRD | −1,89 % | −1,03 % |

Critères a priori :

- **W1 FAIL** — QUARTER sélectionné sur 0/6 trains propres (≥4
  requis). Les portes rendent la plupart des trains inéligibles
  (dd > 10 % les années à fort retour) et l'argmax parmi éligibles
  préfère THIRD les années perdantes (−4,15 % > −4,87 %).
- **W2 FAIL** — le sélectionné ne bat IDENTITY que sur 1/6 tests
  propres ; spread médian 0,00 % (4 folds ont sélectionné = testé
  IDENTITY, spread nul par construction).
- **W3 FAIL** — 1 violation : fold train 2019 → THIRD (dd train
  4,53 %), test 2020 dd **18,61 %** > 10 %. Les portes tenues sur
  le train ne protègent pas le test.

**Verdict : DÉCLASSÉ.** POWER_QUARTER n'est pas déployé ; V1 avec
IDENTITY reste champion. Le doubling in-sample (+3,90 % → +9,20 %)
était un artefact de sélection : les deux fenêtres choisies étaient
toutes deux modestement positives.

Lecture structurelle (donnée par donnée, tous les 40 runs) : le
signe de l'effet calibration suit le signe de l'edge de l'année —
années positives (2016-18, 2020, 2023-24) : QUARTER > THIRD > HALF
> IDENTITY ; années négatives (2019, 2021, 2022) : ordre exact
inverse. **La calibration statique est un levier d'exposition, pas
d'alpha** : elle amplifie l'edge présent, quel qu'en soit le signe,
et aucun profil statique ne peut connaître l'année d'avance. C'est
l'hypothèse directrice du prochain cycle si l'axe sizing reprend :
calibration conditionnée (par régime, cf. §7).

Constat déployé annexe : `riskRejectionRate` > 0 sur les 40 runs
(9,4-28,9 %) — le sélecteur déployé
`selectConfidenceCalibrationProfile` refuserait **tout profil sur
toute fenêtre** (raison RISK_REDUCED). La voie de déploiement du
modèle de calibration est inopérante en l'état ; à traiter
indépendamment (porte trop stricte ou sémantique d'observation à
revoir) avant toute activation future.

## 7. Hors périmètre

- Ré-optimiser les exits ou le gate par fold (un seul levier à la
  fois ; exits gelés en V1).
- Fenêtres intra-annuelles (pas 3/6 mois) — coût de calcul ×4 pour
  information redondante à ce stade.
- Calibration de rsi-reversion (hors `CalibratedStrategyId`).
- Timeframes autres que ONE_DAY.
