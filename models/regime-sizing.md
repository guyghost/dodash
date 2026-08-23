# Sizing conditionné par régime — exposant de calibration par bras de régime

Statut : DÉCLASSÉ (D2-S exécuté le 2026-02-14, verdict W1∧W2∧W3∧WF2-S : DÉCLASSÉ)

## 1. Contexte et décision

Le walk-forward `confidence-sizing-walkforward.md` §6 a **déclassé** la
calibration statique (W1/W2/W3 FAIL). Sa lecture structurelle :

- l'exposant agressif (QUARTER) gagne **massivement en bull extrême**
  (2020 : +130,47 % vs +11,33 % ; 2016-2018 : ×10-18) ;
- il **amplifie les pertes** les années perdantes (2019/2021/2022) ;
- ses dd > 10 % sont concentrés sur les années bull (le drawdown
  intra-bull, pas le bear) ;
- la sélection in-sample ne transfère pas out-of-sample.

Décision : conditionner l'exposant de calibration au **régime** issu de
la machine XState (`regimeFilterMachine`), miroir du pattern déjà établi
pour les exits (`resolveRegimeExitArm`) et le gating
(`resolveRegimePermission`). La décision n°3 du diagnostic
`risk-rejection-diagnosis.md` §7 (redéfinition du gate sélecteur) ne
peut être tranchée qu'avec un profil sélectionnable — ce cycle fournit
l'hypothèse candidate.

**Hypothèse falsifiable H-S1** : l'edge de l'exposant agressif est
concentré en régime BULLISH. En l'appliquant **uniquement** en bull
(IDENTITY ailleurs), on capte le gain bull sans amplifier les pertes
bear/range, avec un drawdown qui reste dans les portes de sécurité.

**Contre-hypothèse H-S0** : le conditionnement ne suffit pas — le dd
intra-bull de l'exposant agressif (> 10 % mesuré en 2016-2018/2020 en
global) traverse les portes même en bull-only, et/ou le transfert OOS
reste instable (miroir du verdict D12). Alors le sizing par calibration
est fermé définitivement, y compris conditionné.

## 2. Mécanique relevée (code existant, inchangé)

Chaîne de décision par candle (replay) :

```
stratégie brute
  → withConfidenceCalibration (statique, profil figé au run ;
    HOLD et erreurs passent ; CalibratedStrategyId = ema-cross|breakout)
  → withTargetSignalNotional (suggestedSize = target/price,
    INDÉPENDANT de la confiance — target-notional-strategy.ts L16-19)
  → gate régime (resolveRegimePermission ; signaux déniés droppés)
  → allocateSignals : net = Σ side × suggestedSize × confidence
    (allocator.ts L84-89 — la confiance module la taille nette)
  → checkRisk
```

- Le **sizing effectif** dépend de la confiance via l'allocateur :
  recalibrer la confiance des signaux entre le gate et l'allocation est
  pleinement effectif.
- Le régime actif est résolu par candle avant le filtrage
  (replay.ts L592-654) : `regimeActor.send(CANDLE_CLOSED)` puis
  `regimeSnapshot.context.regime` (`RegimeKind | null`, null pendant
  le warm-up).
- `calibrateConfidence` (models/confidence-calibration.ts L97-126) :
  pur, transparent sur {0,1}, c → c^k sinon.
- Pattern de policy à bras de régime (models/protective-order.ts
  L15-21, L92-105) : `{ bullish, bearish, range, warmUp }`, régime
  null → bras warmUp.

## 3. Modèle — résolveur de sizing par régime

Nouvelle source de vérité `models/regime-sizing.ts` :

```ts
export interface RegimeConditionalSizingPolicy {
  readonly bullish: ConfidenceCalibrationProfile;
  readonly bearish: ConfidenceCalibrationProfile;
  readonly range: ConfidenceCalibrationProfile;
  readonly warmUp: ConfidenceCalibrationProfile;
}

resolveRegimeSizingProfile(policy, regime: RegimeKind | null)
  → ConfidenceCalibrationProfile
```

Machine du résolveur (implicite, totale, sans transition texte) :

| régime         | bras appliqué   |
|----------------|-----------------|
| BULLISH        | policy.bullish  |
| BEARISH        | policy.bearish  |
| RANGE          | policy.range    |
| null (warm-up) | policy.warmUp   |

Point d'application replay — **après** le gate par permission, **avant**
`allocateSignals`, dans le bloc `regimeActor !== null` :

```
si sizingPolicy ≠ null :
    profile ← resolveRegimeSizingProfile(sizingPolicy, activeRegime)
    si profile = IDENTITY : aucun signal modifié (court-circuit —
        garantit INV-S1 bit-exact par construction, sans recréation)
    sinon, pour chaque signal autorisé :
        si side = HOLD ou strategyId ∉ CalibratedStrategyId : inchangé
        sinon : confidence ← calibrateConfidence(profile, confidence)
```

Aucun autre point de mutation. Le recalibrage n'affecte ni les signaux
déniés (droppés en amont), ni les HOLD (miroir du wrapper statique L23),
ni les stratégies non calibrables (rsi-reversion).

### Invariants

- **INV-S1 (transparence)** — une politique tous-bras IDENTITY laisse
  chaque signal inchangé (`calibrateConfidence("IDENTITY", c) = c` sur
  [0,1]) : le run est **bit-identique** à l'absence de politique.
- **INV-S2 (exclusivité)** — `regimeConditionalSizing` présent ⇒
  `regimeFilter` défini ET `confidenceCalibration` absent de la config
  suite. Deux couches de calibration actives = erreur de config
  (validation, jamais de comportement implicite).
- **INV-S3 (totalité)** — `resolveRegimeSizingProfile` est total sur
  `RegimeKind ∪ {null}` ; aucun chemin par défaut implicite.
- **INV-S4 (restriction)** — le recalibrage ne touche que les signaux
  `side ≠ HOLD` des stratégies `CalibratedStrategyId`.
- **INV-S5 (source unique)** — l'exposant par régime provient
  exclusivement du résolveur models/ ; le replay ne contient aucune
  table d'exposants. Le LLM n'intervient à aucun endroit (résolveur
  déterministe pur).

## 4. Instrumentation

Aucune nouvelle métrique : les métriques économiques standard
(return, dd, trades, winRate, notionals médians par stratégie,
turnover, fees) suffisent au protocole. Le régime final est déjà
exposé dans `RegimeGatingSummary`.

## 5. Implémentation (consumers)

- `models/confidence-calibration.ts` : exporter
  `CALIBRATED_STRATEGY_IDS` et `isCalibratedStrategyId` (source unique
  de la restriction, aujourd'hui privée).
- `models/regime-sizing.ts` : policy, validateur, résolveur (+ export
  `models/index.ts`).
- `packages/backtest/src/suite.ts` : champ
  `regimeConditionalSizing?: RegimeConditionalSizingPolicy` dans
  `BacktestSuiteConfig` + validation INV-S2 + passage au replay.
- `packages/backtest/src/replay.ts` : champ dans `BacktestConfig`,
  validation INV-S2, recalibrage au point §3.

## 6. Protocole de vérification (D2-S)

**Une seule campagne** (les runs par fenêtre servent à la fois de
train et de test, miroir D12) :

- 10 fenêtres annuelles (étiquettes 2016..2025, bornes
  `[YYYY-08-21 → YYYY+1-08-21]` UTC alignées — miroir exact de
  `windowBounds` du script D12) × 4 candidats, config V1
  bit-identique au walk-forward D12 (exits REGIME_CONDITIONAL 300/600,
  gate EMA_THRESHOLD 100/5/3, fees 6 bps, slippage 2 bps, capital
  10 000, targetSignalNotional 1 000, risk V1, pré-validation spot et
  fenêtre dailyPnl désormais structurelles).
- **Espace de candidats figé a priori** (un seul degré de liberté —
  l'exposant bull) :
  `C_k = { bullish: k, bearish: IDENTITY, range: IDENTITY, warmUp:
  IDENTITY }` pour k ∈ {IDENTITY, POWER_HALF, POWER_THIRD,
  POWER_QUARTER}.
- Sélection par fold : portes CS4 sur le train (médiane notional ∈
  [100,400] par stratégie calibrable, dd ≤ 10 %, turnover ≤ 10,
  feeRate ≤ 1 %, run actif) puis argmax return parmi éligibles ;
  défaut IDENTITY — règle identique à D12 pour comparabilité.
- 9 folds origine glissante (train année N → test N+1) ; folds
  **propres** = ni train ni test ∈ {2023, 2025} (fenêtres contaminées
  par la sélection in-sample d'origine) → 6 folds propres.
- Contrôles : WF2-S — C_IDENTITY reproduit bit-pour-bit les baselines
  (2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 %) ; cohérence
  secondaire avec la grille annuelle IDENTITY de D12.

## 7. Critères de verdict (D3-S, a priori, folds propres uniquement)

- **W1 — stabilité** : un même candidat sélectionné sur ≥ 4/6 trains
  propres.
- **W2 — transfert OOS** : le candidat sélectionné bat C_IDENTITY en
  return test sur ≥ 4/6 folds propres ET spread médian > 0.
- **W3 — sécurité OOS** : dd test ≤ 10 % sur les folds propres pour
  le candidat sélectionné.
- **Verdict VALIDÉ** exige W1 ∧ W2 ∧ W3 ∧ WF2-S. Tout autre issue =
  DÉCLASSÉ → H-S0 retenue, l'axe sizing par calibration est fermé
  (statique ET conditionné). Aucune conclusion « mieux » sans critère
  a priori rempli.

## 8. Résultats (D2-S, campagne du 2026-02-14)

Grille annuelle `ret / dd` (%, config V1, 40 runs) :

| Fenêtre | IDENTITY | HALF | THIRD | QUARTER |
|---|---|---|---|---|
| 2016 | 2,35 / 1,50 | 15,49 / 8,57 | 30,90 / 15,20 | 45,37 / 20,05 |
| 2017 | 3,85 / 6,88 | 28,50 / 19,65 | 52,07 / 25,45 | 69,05 / 27,97 |
| 2018 | 3,48 / 3,48 | 14,58 / 11,91 | 25,70 / 17,71 | 36,40 / 19,55 |
| 2019 | −2,60 / 3,45 | −3,32 / 3,89 | −4,15 / 4,53 | −4,87 / 5,09 |
| 2020 | 11,33 / 4,82 | 58,35 / 13,99 | 101,27 / 18,61 | 130,47 / 20,49 |
| 2021 | −5,81 / 6,21 | −6,60 / 7,11 | −7,48 / 8,40 | −8,23 / 9,46 |
| 2022 | −1,03 / 1,74 | −1,39 / 2,40 | −1,89 / 3,01 | −2,16 / 3,46 |
| 2023 | 0,27 / 2,93 | 2,21 / 4,69 | 4,20 / 6,24 | 5,81 / 7,39 |
| 2024 | 2,01 / 0,59 | 3,27 / 1,87 | 4,64 / 3,46 | 5,86 / 4,75 |
| 2025 | 3,63 / 3,37 | 3,56 / 3,43 | 3,47 / 3,52 | 3,39 / 3,61 |

- **WF2-S : PASS** — C_IDENTITY reproduit bit-pour-bit les baselines V1
  (2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 %). La mesure est
  valide.
- **Mécanisme du verdict** : la direction de H-S1 est confirmée en
  in-sample (return bull croît avec l'exposant), mais la porte CS4
  `dd ≤ 10 %` est le binding constraint — chaque candidat k ≠ IDENTITY
  dépasse 10 % de drawdown sur au moins une fenêtre de chaque train
  propre (ex. train 2016→2017 : HALF dd 8,57 % sur 2016 mais 19,65 % sur
  2017). D'où `éligibles [aucun]` sur 9/9 trains → défaut IDENTITY.
- **W1 : PASS** (IDENTITY sur 6/6 trains propres — trivial, par défaut).
  **W2 : FAIL** (0/6, spread médian 0,00 % — mécanique : le sélectionné
  EST C_IDENTITY). **W3 : PASS** (0 violation dd test).
- **Verdict : DÉCLASSÉ** — H-S0 retenue. L'axe sizing par calibration
  est fermé (statique D12 ET conditionné D2-S).
- Info déploiement (hors verdict) : bull=QUARTER serait refusé par le
  sélecteur déployé sur 4/10 fenêtres (riskRej 3–24 %, max 24,49 % en
  2020) — confirme la non-déployabilité opérationnelle.
- Annexes : fenêtres faibles (2019, 2021, 2022) dégradées
  monotones avec k — le conditionnement bull n'aide pas hors bull ;
  2025 quasi-neutre (léger décroissance).

## 9. Limites épistémiques et hors périmètre

- **Médianes CS4 mesurées pré-sizing** (constat post-campagne, review
  PR#1) : les observations `requestedNotional` des diagnostics du replay
  sont poussées avant l'application du recalibrage conditionnel
  (`replay.ts` : diagnostics L626, `regimeConditionalSizing` L713) ; la
  porte médiane du script a donc lu des notionnels pré-sizing, non
  comparables à D12 où le sizing est appliqué en amont dans la stratégie
  wrappée. **Non-binding sur le verdict** : la porte dd ≤ 10 % a exclu
  chaque candidat k ≠ IDENTITY sur chaque train propre (§8,
  `éligibles [aucun]` 9/9) — la médiane n'a jamais déterminé
  l'éligibilité ni la sélection, et le défaut IDENTITY (W2 FAIL
  mécanique) est invariant. Toute réouverture de l'axe devra
  instrumenter des notionnels post-sizing dans le replay.

- **Nature du déclassement** : non-éligibilité à la porte de risque
  a priori (CS4-dd), pas défaite OOS d'un candidat sélectionné — le
  signal directionnel de H-S1 n'a jamais été testé OOS parce qu'aucun
  candidat conditionné n'a franchi la sélection. Toute réouverture de
  l'axe sizing devra soit assouplir la contrainte dd (décision de
  risque explicite, pas un ajustement implicite), soit découpler
  notional et drawdown (ex. sizing vol-adjusté) — nouveaux cycles,
  nouveaux modèles.
- **Limite documentée** : l'espace de candidats (conditionnement bull)
  a été formulé après lecture de la grille D12 complète — le
  walk-forward protège contre la sélection du **paramètre** (exposant
  bull) mais pas contre la sélection de l'**hypothèse structurelle**.
  W2 mesure le transfert du conditionnement, pas un edge prouvé ex
  nihilo. Toute décision de déploiement devra le mentionner.
  (Académique : W2 n'a jamais pu s'exécuter, voir §8.)
- Hors périmètre : rsi-reversion (hors CalibratedStrategyId) ;
  conditionnement d'autres dimensions (exits, gate) — un seul levier
  par cycle ; implémentation live du recalibrage (posture : backtest
  d'abord, live si et seulement si VALIDÉ) ; redéfinition du gate
  sélecteur (décision n°3 du diagnostic, après ce cycle) ;
  timeframes infra-journaliers.
