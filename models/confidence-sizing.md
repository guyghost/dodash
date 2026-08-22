# Sizing par calibration de confiance v1

Statut : SUCCÈS IN-SAMPLE — POWER_QUARTER DÉCLASSÉ en walk-forward
(cf. `confidence-sizing-walkforward.md` §6) ; V1/IDENTITY reste
champion déployé
Date : 2026-08-22
Prérequis : `confidence-calibration.ts` (modèle existant, 4 profils),
`regime-exit.md` (V1 champion côté exits : bras bearish/range/warmUp
**FIXED 300/600** — correction apportée en phase Verify, voir §5),
`bull-alpha-diagnosis.md` (bull non protégé +7,42 %, wr 100 %, sizing
minuscule — la bot a raison mais taille trop petit).

## 1. Problème

Quatre cycles d'exits ont établi que V1 est l'optimum local côté
sorties. Le résidu bull (V1 +0,27 % contre +7,42 % non protégé) ne
vient pas de quand on sort mais de **combien on est engagé quand on a
raison** : diagnostic bull = 100 % de win rate mais notional médian
proche de zéro (ema-cross tiny sizing). La confiance brute des
stratégies écrase la taille (confiance faible → taille faible).

Le levier existe déjà, modélisé et pur : `calibrateConfidence`
(exposant par profil, `c → c^k`, k ∈ {1, ½, ⅓, ¼}). Tout k < 1 relève
la confiance (donc la taille) sans toucher aux signaux, au gating ni
aux exits. La fonction de sélection `selectConfidenceCalibrationProfile`
définit déjà les portes opérationnelles : notion médiane demandée ∈
[100, 400] par stratégie, dd ≤ 10 %, turnover ≤ 10, fees ≤ 1 %.

## 2. Changement du modèle

**Aucun changement de comportement.** Le modèle existant couvre :

- `calibrateConfidence` : pure, idempotente sur {0, 1}, monotone
  croissante en c pour tout k ;
- `withConfidenceCalibration` (wrapper stratégie, backtest) : appliqué
  en amont de l'allocation, HOLD et erreurs traversent inchangés ;
- bornes et portes : inchangées.

Ce cycle est une **campagne de mesure** sur configurations existantes
(même nature que `bull-alpha-diagnosis.md`) :

- exits : V1 (REGIME_CONDITIONAL, bull NONE, bear/range/warmUp FIXED
  **300/600**) ;
- gate : EMA_THRESHOLD 100/5/3 ;
- variable unique : `confidenceCalibration` ∈ {IDENTITY, POWER_HALF,
  POWER_THIRD, POWER_QUARTER}.

## 3. Invariants

| # | Invariant |
| --- | --- |
| CS1 | La calibration ne change ni les signaux émis (side/stratégie), ni le gate, ni les exits — seule la taille allouée bouge |
| CS2 | IDENTITY = bit-identité avec V1 mesuré (bull +0,27 % dd 2,93 %, bear +3,63 % dd 3,37 % — cf. checkpoint 006, mesure CLI `--stop-loss-bps 300 --take-profit-bps 600`) |
| CS3 | Ordre partiel attendu : exposition croissante avec k décroissant (QUARTER ≥ THIRD ≥ HALF ≥ IDENTITY), monotonie vérifiable sur la notion médiane |
| CS4 | Chaque profil reste dans les portes opérationnelles de sélection : notion médiane ∈ [100, 400], dd ≤ 10 %, turnover ≤ 10, fees ≤ 1 % — sinon profil inéligible au déploiement quel que soit son return |

## 4. Plan de mesure

- Fenêtres : bull 2023-08-21→2024-08-21, bear 2025-08-21→2026-08-21.
- Grille : 4 profils × 2 fenêtres, métriques : return, dd, win rate,
  trades, stops, takes + **notion médiane demandée par stratégie**
  (depuis `diagnosticSamples.requestedNotionalByStrategy` du scénario
  ensemble). Turnover et feeRate sont dérivés des métriques du
  scénario ensemble si exposés, sinon estimés depuis les diagnostics
  (fees cumulées / capital initial).
- La porte notion médiane (CS4) s'applique **par fenêtre et par
  stratégie calibrée** (ema-cross, breakout), comme les observations de
  `selectConfidenceCalibrationProfile` (runKey × stratégie).
- Critères a priori (même fenêtre, même cellule) :
  1. composite (bull + bear) > +3,90 % (V1) ;
  2. dd ≤ 10 % sur les deux fenêtres ;
  3. porte CS4 satisfaite sur les deux fenêtres ;
  4. bear ne dégrade pas sous +3 %.
- Attendu : les k intermédiaires (HALF, THIRD) maximisent le composite
  si le sizing est le goulot ; QUARTER risque de dépasser les portes
  (notion médiane > 400) ou la dd en bear. *(Attendu démenti : cf. §5 —
  HALF/THIRD échouent par taille trop **petite**, QUARTER passe.)*

## 5. Résultats et verdict

Grille mesurée le 2026-08-22 (`scripts/confidence-sizing-sensitivity.ts`,
exits V1 300/600, gate 100/5/3, UNSET = IDENTITY bit-identique vérifié) :

| profil | bull | bear | composite | dd max | porte CS4 |
| --- | --- | --- | --- | --- | --- |
| IDENTITY (= V1) | +0,27 % dd 2,93 % | +3,63 % dd 3,37 % | +3,90 % | 3,37 % | ✗ (ema-cross $1-2) |
| POWER_HALF | +2,21 % dd 4,69 % | +3,56 % dd 3,43 % | +5,77 % | 4,69 % | ✗ (ema-cross $29-44) |
| POWER_THIRD | +4,20 % dd 6,24 % | +3,47 % dd 3,52 % | +7,67 % | 6,24 % | ✗ (ema-cross bear $94) |
| POWER_QUARTER | +5,81 % dd 7,39 % | +3,39 % dd 3,61 % | **+9,20 %** | 7,39 % | ✔ ($170-365) |

Notion médiane demandée QUARTER : breakout $365 (bull) / $321 (bear),
ema-cross $210 / $170. rsi-reversion $501-585 non calibré (hors
`CalibratedStrategyId`).

Contrôles des invariants :

- **CS1 ✔** — trades/stops/takes identiques à l'identique près sur
  toutes les cellules (50/5/4 bull, 89/23/8/1 bear) : la calibration ne
  touche ni signaux, ni gate, ni exits.
- **CS2 ✔** — UNSET (champ absent) = IDENTITY = V1 **bit-identique** :
  baseline reproduite au centième (bull +0,27 % dd 2,93 %, bear +3,63 %
  dd 3,37 %).
- **CS3 ✔** — monotonie de l'exposition et du return bull :
  QUARTER ≥ THIRD ≥ HALF ≥ IDENTITY ( notion médiane ema-cross
  $1-2 → $29-44 → $94 → $170-210).
- **CS4 ✔ pour QUARTER uniquement** — notion médiane ∈ [100, 400] sur
  les deux fenêtres ; contrôle résiduel
  (`scripts/confidence-sizing-quarter-check.ts`) : turnover 3,93 (bull)
  / 6,24 (bear) ≤ 10 ; feeRate 0,06 % du notional brut échangé ≤ 1 %.
  HALF/THIRD échouent la porte notional (trop petit, pas trop gros).

Critères a priori (§4) :

1. composite +9,20 % > +3,90 % ✔
2. dd ≤ 10 % partout (max 7,39 %) ✔
3. porte CS4 sur les deux fenêtres ✔ (QUARTER seul)
4. bear +3,39 % ≥ +3 % ✔

**Verdict : SUCCÈS.** POWER_QUARTER double le composite V1 (+3,90 % →
+9,20 %) en respectant toutes les portes opérationnelles, sans toucher
aux signaux ni aux exits. Le mécanisme est exactement le diagnostic
bull : mêmes trades, même win rate, taille relevée par l'exposant ¼.
Déploiement = flag CLI existant `--confidence-calibration
POWER_QUARTER` (aucun changement de code). Robustesse walk-forward
hors périmètre de ce cycle (cf. §6). **Épilogue : le walk-forward
(`confidence-sizing-walkforward.md`) a déclassé QUARTER — l'edge
in-sample était un artefact des deux fenêtres, toutes deux
modestement positives ; ne pas déployer.**

Erratum de mesure : la première passe de grille utilisait bear/range/
warmUp FIXED **600/600** (bras hérité de v3 par erreur de reprise) ;
corrigé en **300/600** après recoupement avec le checkpoint 006 (V1
mesuré via CLI `--stop-loss-bps 300 --take-profit-bps 600`), baseline
alors reproduite bit pour bit. Les dates du doc initial (2025-12-17)
corrigées en 2026-08-22 (dates réelles des fenêtres).

## 6. Hors périmètre

- Changer k par régime (calibration conditionnée) — un seul levier à
  la fois.
- Nouveaux profils (exposants supplémentaires) — mesurer d'abord
  l'existant.
- Toucher aux exits, au gate, aux stratégies.
- Validation walk-forward / out-of-sample de QUARTER — la grille reste
  in-sample sur deux fenêtres choisies a priori ; la robustesse
  temporelle est un cycle séparé.
