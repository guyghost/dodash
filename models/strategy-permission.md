# Permission par stratégie × régime — reconfiguration du gate

Statut : MODÉLISÉ

## 1. Contexte et décision

Le diagnostic `weak-year-diagnosis.md` §6 (MESURÉ, INV-D1/D2 PASS)
localise la perte des années faibles : dominante `BEARISH|protective`
(83 % et 96 % de la perte nette en 2019/2021) et `RANGE|protective`
(90 % en 2022), wr 22-33 %, stops ≫ takes ; M5 désigne rsi-reversion
comme unique porteuse (solo ≈ ensemble). Verdict arbre §4 : branche 2
(avec composante branche 1) — la perte naît à la **source des entrées**,
pas des exits (axe fermé) ni du sizing (axe fermé).

Découverte structurante : le mécanisme de permission existe déjà et est
inversé par rapport au besoin. `DEFAULT_REGIME_PERMISSIONS`
(models/regime-filter.ts L10-14) autorise **rsi-reversion uniquement**
en BEARISH et RANGE — c'est la seule stratégie autorisée là où la perte
se concentre. Le replay appelle `resolveRegimePermission` **sans**
passer de table (replay.ts L658-661) : la table par défaut est codée
en dur, non configurable.

Décision : rendre la table de permission configurable et évaluer des
reconfigurations a priori par walk-forward. **Un seul degré de liberté**
par candidat : la liste `BEARISH` (et son miroir `RANGE`).

**Hypothèse falsifiable H-P1** : la perte des années faibles provient
des entrées de rsi-reversion en BEARISH (et partiellement en RANGE) ;
les interdire améliore le return des fenêtres faibles sans dégrader
les fortes au-delà des portes de sécurité.

**Contre-hypothèse H-P0** : le retrait ne transfère pas OOS (sélection
instable, spread nul, ou dd cassé) → la permission par régime est
fermée ; le problème est l'edge de base → branche 4 du diagnostic
(signaux/data), pas le plumbing.

## 2. Mécanique relevée (code existant, inchangé sauf câblage)

Chaîne par candle (replay.ts L656-669) :

```
signaux évalués
  → pour chaque signal :
      activeRegime = regimeActor.context.regime   (RegimeKind | null)
      permission = activeRegime === null
        ? null                                     (warm-up)
        : resolveRegimePermission(activeRegime, strategyId)
    permission ok ∧ true  → signal gardé (signalsPassed)
    sinon                 → signal droppé (signalsFiltered,
                            deniedByStrategy[strategyId] += 1)
  → sizing conditionné (éventuel) → allocateSignals → checkRisk
```

- `resolveRegimePermission(regime, strategyId, permissions)`
  (models/regime-filter.ts L104-117) : pur, total, déterministe —
  `allowed.includes(strategyId)`. **La source de vérité existe déjà.**
- Permission **side-agnostique** : filtre par (strategyId, régime) ;
  un SELL rsi en BULLISH est dénié comme un BUY. Hérité, inchangé
  ce cycle (§9).
- **Warm-up** : `activeRegime === null` → permission `null` → **tout
  signal est dénié** (else-branch L665-667). Hérité, inchangé (4-5
  jours par fenêtre, négligeable mais documenté).
- Diagnostic existant `RegimeGatingSummary.deniedByStrategy` expose
  déjà l'effectif dénié par stratégie — l'instrumentation du contrôle
  d'effet est gratuite.

## 3. Modèle — policy de permission configurable

La table par défaut devient un paramètre de config optionnel ; le
résolveur `models/regime-filter.ts` reste l'unique source de vérité
(aucune logique nouvelle dans le replay).

```ts
// models/regime-filter.ts (existant, enrichi)
export const isValidRegimePermissions = (
  value: unknown,
): value is RegimePermissions => /* Record complet sur RegimeKind,
  listes de strings non vides, sans doublon */;

// packages/backtest/src/replay.ts — BacktestConfig
readonly regimePermissions?: RegimePermissions;

// point d'application (L658-661, unique mutation) :
const permissions = config.regimePermissions ?? DEFAULT_REGIME_PERMISSIONS;
const permission =
  activeRegime === null
    ? null
    : resolveRegimePermission(activeRegime, signal.strategyId, permissions);
```

### Invariants

- **INV-P1 (transparence)** — `regimePermissions` absent ⇒ le résolveur
  reçoit `DEFAULT_REGIME_PERMISSIONS` : le run est **bit-identique** à
  V1 (contrôle WF3-P). Aucun chemin de config ne change le comportement
  par défaut.
- **INV-P2 (totalité)** — la policy validée couvre les 3 `RegimeKind`
  (listes éventuellement vides = régime interdit à tous) ; un
  strategyId inconnu du registry mais présent dans la table est un
  no-op (jamais produit par le registry) ; un strategyId du registry
  absent de la table de son régime est dénié. Aucun défaut implicite.
- **INV-P3 (source unique)** — la table provient exclusivement de la
  config validée ; le replay ne contient aucune table locale. Résolveur
  déterministe pur, aucun LLM nulle part.
- **INV-P4 (side-agnosticisme, assumé)** — la permission ignore le side
  du signal (héritage du gate v1, inchangé ce cycle, §9).
- **INV-P5 (warm-up hérité)** — régime `null` ⇒ tout dénié, quelle que
  soit la table (héritage inchangé).

## 4. Espace de candidats (figé a priori)

Un seul degré de liberté : la permission de rsi-reversion hors BULLISH.
`[ema-cross, breakout]` en BULLISH est identique partout (jamais
touché par le diagnostic).

| Candidat | BULLISH | BEARISH | RANGE | Lecture |
|---|---|---|---|---|
| C0 (défaut) | [ema, brk] | [rsi] | [rsi] | baseline V1 |
| C1 rsi-bear-off | [ema, brk] | [] | [rsi] | chirurgical : coupe les entrées bear (39/56/17t par an sur 2019/2021/2022) |
| C2 rsi-off | [ema, brk] | [] | [] | rsi désactivé partout ≈ ablation M5 (+2,46/+5,67/+0,98 % faibles ; −0,71/−0,11/−1,72 fortes) |

C2 est la formalisation de l'ablation M5 mesurée en diagnostic — le
walk-forward la soumet aux mêmes portes et à la sélection par fold que
C1 ; aucune conclusion M5 n'est réutilisée comme verdict.

## 5. Implémentation (consumers)

- `models/regime-filter.ts` : `isValidRegimePermissions` (+ export
  index). Aucun changement de `resolveRegimePermission` (déjà
  paramétré).
- `packages/backtest/src/replay.ts` : champ `regimePermissions?` dans
  `BacktestConfig`, validation INV-P2 à l'entrée, câblage L658-661
  (unique point de mutation, INV-P1/P3).
- `packages/backtest/src/suite.ts` : champ optionnel pass-through dans
  `BacktestSuiteConfig` (aucune interaction avec INV-S2 : la permission
  est amont du sizing, orthogonale).
- `packages/backtest/scripts/regime-permission-walkforward.ts` : miroir
  de `regime-sizing-walkforward.ts` (fenêtres, portes CS4, folds,
  sélecteur, rapport — seuls les candidats changent).

## 6. Protocole de vérification (D3-P)

**Une seule campagne** (miroir D2-S, comparabilité stricte) :

- 10 fenêtres annuelles (2016..2025, bornes `[YYYY-08-21 →
  YYYY+1-08-21]` UTC) × 3 candidats {C0, C1, C2}, config V1
  bit-identique D2-S (gate EMA_THRESHOLD 100/5/3, exits
  REGIME_CONDITIONAL 300/600, calibration IDENTITY, sizing absent,
  fees 6 bps, slippage 2 bps, capital 10 000, risk V1) — seul
  `regimePermissions` varie. 30 runs.
- Sélection par fold : portes CS4 sur le train (médiane notional ∈
  [100,400] par stratégie calibrable, dd ≤ 10 %, turnover ≤ 10,
  feeRate ≤ 1 %, run actif) puis argmax return parmi éligibles ;
  défaut C0. Règle identique D2-S/D12.
- 9 folds origine glissante (train N → test N+1) ; folds **propres** =
  ni train ni test ∈ {2023, 2025} → 6 folds propres.
- **WF3-P (contrôle bit-exact)** — C0 reproduit bit-pour-bit les
  baselines V1 (2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 %).
- **Contrôle d'effet (nouveau, gratuit)** — `deniedByStrategy["rsi-reversion"]
  > 0` est déjà vrai en C0 (deny-all du warm-up compte les signaux rsi
  warm-up) : le contrôle doit donc être un **delta** —
  `denied(C_k) − denied(C0) > 0` sur les fenêtres faibles (les signaux
  bear/range supprimés existent), et côté fills : **zéro fill d'entrée
  rsi en BEARISH pour C1, zéro fill rsi partout pour C2**. Une policy
  silencieuse (delta nul, fills inchangés) invalide la campagne.

## 7. Critères de verdict (a priori, folds propres uniquement)

- **W1 — stabilité** : un même candidat sélectionné sur ≥ 4/6 trains
  propres.
- **W2 — transfert OOS** : le candidat sélectionné bat C0 en return
  test sur ≥ 4/6 folds propres ET spread médian > 0.
- **W3 — sécurité OOS** : dd test ≤ 10 % sur les folds propres pour le
  candidat sélectionné.
- **Verdict VALIDÉ** exige W1 ∧ W2 ∧ W3 ∧ WF3-P ∧ contrôle d'effet.
  Tout autre issue = DÉCLASSÉ → H-P0 retenue : la permission par
  régime est fermée, priorité aux signaux/data (branche 4 du
  diagnostic).

## 8. Résultats

(à compléter après exécution)

## 9. Limites et hors périmètre

- **Side-agnosticisme** (INV-P4) : interdire rsi en BEARISH coupe aussi
  ses SELL éventuels en BEARISH. Non mesuré séparément ce cycle ; si
  C1 VALIDÉ, une refinement par side est un cycle ultérieur éventuel.
- **Warm-up deny-all** (INV-P5) : hérité, non retouché — hors degré de
  liberté de ce cycle.
- Attribution diagnostique par régime de **clôture** : la perte
  `BEARISH|protective` peut inclure des entrées RANGE clôturées en
  BEARISH — c'est précisément pourquoi C1 (bear seul) et C2 (bear+range)
  sont tous deux candidats plutôt qu'un choix post hoc.
- C2 retire rsi même de ses années gagnantes (2024 : solo +1,72 %) ;
  le coût est accepté a priori et mesuré par le walk-forward.
- Les portes CS4 « médiane notional par stratégie calibrable » ne
  couvrent que ema-cross/breakout (`CALIBRATED_STRATEGY_IDS`) — dont
  les permissions ne changent pas : l'effet C1/C2 sur rsi n'est vu par
  le sélecteur que via return/dd/turnover globaux. Pas de porte dédiée
  à l'effectif rsi ; gardées telles quelles pour la comparabilité.
