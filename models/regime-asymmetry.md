# Régime filtre — seuil BEARISH asymétrique (v3)

Statut : PROPOSÉ
Date : 2025-12-17
Prérequis : `regime-filter.md` (machine EMA_THRESHOLD), `regime-exit-v2.md` (constat structural)

## 1. Problème

`regime-exit-v2.md` établit un constat structural : en année bull, les creux
sont classifiés BEARISH par la politique symétrique `EMA_THRESHOLD`
(`thresholdBps = 100` des deux côtés). Les positions ouvertes pendant ces
creux héritent du bras BEARISH de l'exit protectif (stop serré 300 bps),
qui détruit la valeur bull (V1 : +0,27 % vs +7,42 % sans protection).

Le même stop serré protège l'année bear (+3,63 % vs −15,13 %). V2 démontre
qu'aucun réglage statique par régime ne résout la tension : élargir le bras
BEARISH (600/1200) récupère le bull (+4,30 %) mais effondre le bear
(−12,53 %).

**Hypothèse centrale** : un creux bull et une tendance bear se distinguent
par la *profondeur* de l'écart EMA fast/slow. Un seuil BEARISH plus profond
que le seuil BULLISH (asymétrie) re-classe les creux bull en RANGE sans
dé-classifier les tendances bear soutenues.

## 2. Changement du modèle

### 2.1 Politique

`EmaThresholdRegimePolicy` gagne un champ optionnel :

```ts
readonly bearishThresholdBps?: number;
```

- Absent → comportement v1 strictement identique (défaut = `thresholdBps`).
- Présent → borne la classification BEARISH uniquement ; BULLISH reste
  gouverné par `thresholdBps`.

### 2.2 Classification (fonction pure, machine inchangée)

`classifyRegimeObservation`, branche EMA_THRESHOLD :

```text
gap = emaFast / emaSlow − 1  (en bps)
BULLISH si gap > +thresholdBps
BEARISH si gap < −bearishThresholdBps_effectif   (bearish ?? threshold)
RANGE   sinon
```

La machine XState (`regime-filter.machine.ts`) n'est **pas modifiée** :
warm-up, streaks de confirmation (`confirmationCount`), transitions
`regimeBullish`/`regimeBearish`/`regimeRange`, états terminaux
`stopped`/`failed` restent identiques. L'asymétrie n'agit que sur la
classification brute en entrée des gardes.

### 2.3 Permissions

`DEFAULT_REGIME_PERMISSIONS` inchangé. Re-labeliser un creux BEARISH → RANGE
ne change pas les stratégies autorisées (rsi-reversion permis dans les deux) ;
cela change uniquement le bras d'exit protectif et les statistiques de gating.

### 2.4 CLI et reproductibilité

- Flag `--regime-bearish-threshold-bps <bps>` (optionnel).
- Manifeste `runId` / suffixe d'artefact : la partie `regime:{threshold}:…`
  n'est étendue (`regime:{t}:{bear}:{minObs}:{conf}`) **que si le flag est
  fourni**. Sans flag → runId bit-identique v1.

## 3. Invariants

| # | Invariant |
|---|-----------|
| RA1 | `bearishThresholdBps` absent → classification bit-identique à v1 sur toute séquence d'observations |
| RA2 | Présent → `Number.isFinite`, `> 0`, `< 10000`, sinon politique invalide (machine → `failed`, code `INVALID_REGIME_POLICY`) |
| RA3 | Seule la branche BEARISH est affectée ; BULLISH/RANGE à gap donné sont inchangés |
| RA4 | Permissions et gating inchangés (aucune stratégie n'est (dés)autorisée par l'asymétrie) |
| RA5 | Flag CLI absent → `runId` et chemin d'artefact bit-identiques v1 |
| RA6 | Aucune décision d'état déléguée à un LLM ; la classification reste une fonction pure déterministe |
| RA7 | `--regime-bearish-threshold-bps` rejeté si `--regime-filter` vaut `NONE` ou `EMA_SLOPE` (champ spécifique au mode, miroir de R6) |

Précision flottante (RA1) : la branche EMA_THRESHOLD conserve les inégalités
strictes v1, sans epsilon (contrairement à EMA_SLOPE), pour garantir la
bit-identité lorsque le champ est absent. L'ordre relatif
`bearishThresholdBps` vs `thresholdBps` n'est pas contraint (RA2) : une
asymétrie inversée reste une politique valide à mesurer.

## 4. Plan de mesure (étude de sensibilité)

Fenêtres identiques aux études précédentes : bull 2023-08-21→2024-08-21,
bear 2025-08-21→2026-08-21.

Sortie protectif : `REGIME_CONDITIONAL`, bras BULLISH = NONE, bras BEARISH =
300/600, warmUp = 300/600 ; le bras RANGE varie (le re-labeling creux→RANGE
n'a d'effet que si le bras RANGE diffère du bras BEARISH — V2 a montré
RANGE=300/600 équivalent BEARISH sur les stops).

Grille (9 cellules × 2 fenêtres) :

| Cellule | bearishThresholdBps | Bras RANGE |
|---------|--------------------|------------|
| D1 (ctl = V1) | 100 | 300/600 |
| D2 | 200 | 300/600 |
| D3 | 300 | 300/600 |
| E1 | 200 | 600/1200 |
| E2 | 300 | 600/1200 |
| F1 | 200 | NONE |
| F2 | 300 | NONE |
| F3 | 150 | NONE |

### Critères de succès a priori

- Bull : rendement total ≥ +3 % **et** drawdown ≤ 10 %
- Bear : rendement total > 0 % **et** drawdown ≤ 10 %
- Les deux fenêtres doivent passer simultanément (même cellule).

Rationale : bull +3 % capte une récupération substantielle vs V1 (+0,27 %)
sans exiger le maximum non protégé (+7,42 %) ; bear > 0 % et dd ≤ 10 %
garantissent que la protection bear n'est pas sacrifiée (V1 : +3,63 %, dd 3,4 %).

### Attendus par mécanisme

- Si le mécanisme (re-classement creux→RANGE) est la bonne explication :
  D2/D3 se rapprochent du bull non protégé à mesure que bearishThreshold
  monte, tandis que le bear reste protégé tant que les tendances bear
  franchissent le seuil profond.
- Si D2/D3 ≈ D1 sur le bull : le mécanisme est invalide (les stops bull ne
  viennent pas de creux classés BEARISH) → piste suivante : exits trailing
  ou temporels.

## 5. Hors périmètre

- Modes de classification alternatifs (EMA_SLOPE, hystérésis par
  confirmationCount différencié) : à modéliser séparément si l'asymétrie
  échoue.
- Changement des permissions par régime.
- Toute décision d'état pilotée par texte libre ou LLM (interdit par la
  règle d'architecture).
