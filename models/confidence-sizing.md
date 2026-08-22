# Sizing par calibration de confiance v1

Statut : PROPOSÉ
Date : 2025-12-17
Prérequis : `confidence-calibration.ts` (modèle existant, 4 profils),
`regime-exit.md` (V1 champion côté exits : composite +3,90 %),
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
  600/600) ;
- gate : EMA_THRESHOLD 100/5/3 ;
- variable unique : `confidenceCalibration` ∈ {IDENTITY, POWER_HALF,
  POWER_THIRD, POWER_QUARTER}.

## 3. Invariants

| # | Invariant |
| --- | --- |
| CS1 | La calibration ne change ni les signaux émis (side/stratégie), ni le gate, ni les exits — seule la taille allouée bouge |
| CS2 | IDENTITY = bit-identité avec V1 mesuré (bull +0,27 %, bear +3,63 %) |
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
  (notion médiane > 400) ou la dd en bear.

## 5. Hors périmètre

- Changer k par régime (calibration conditionnée) — un seul levier à
  la fois.
- Nouveaux profils (exposants supplémentaires) — mesurer d'abord
  l'existant.
- Toucher aux exits, au gate, aux stratégies.
