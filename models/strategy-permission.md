# Permission par stratégie × régime — reconfiguration du gate

Statut : MESURÉ (D3-P2 DÉCLASSÉ — test réel, H-P0 retenue ; axe
permission fermé sous règle de sélection figée, priorité branche 4
signaux/data)

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

## 8. Résultats (D3-P, campagne du 2026-02-14, 27 runs)

Fenêtre 2016 éliminée proprement (HISTORICAL_NETWORK_UNAVAILABLE,
by design). Grille annuelle `ret / dd` (%, config V1-IDENTITY) :

| Fenêtre | C0 défaut | C1 bear∅ | C2 bear+range∅ |
|---|---|---|---|
| 2017 | 3,85 / 6,88 | 5,88 / 6,30 | 6,22 / 6,30 |
| 2018 | 3,48 / 3,48 | 4,14 / 3,45 | 3,70 / 3,47 |
| 2019 | −2,60 / 3,45 | −0,23 / 1,06 | −0,14 / 0,30 |
| 2020 | 11,33 / 4,82 | 11,07 / 4,54 | 11,22 / 4,45 |
| 2021 | −5,81 / 6,21 | −1,17 / 1,47 | −0,14 / 0,24 |
| 2022 | −1,03 / 1,74 | −0.83 / 1,43 | −0,05 / 0,19 |
| 2023 | 0,27 / 2,93 | 0,76 / 1,52 | 0,50 / 0,56 |
| 2024 | 2,01 / 0,59 | 1,53 / 0,36 | 0,29 / 0,35 |
| 2025 | 3,63 / 3,37 | 0,57 / 0,73 | −0,01 / 0,02 |

- **Mécanisme** (années faibles) : C1 écrase la perte — 2019 +2,37 pp,
  2021 +4,64 pp, 2022 +0,20 pp ; C2 renforce encore (2021 : −0,14 %).
  Coût visible les années gagnantes : 2024 −0,48 pp (C1), 2025 −3,06 pp
  (C1) où rsi porte le gain — cohérent avec §9. dd réduite sur 9/9 par
  C1 ; turnover ÷4-6 (6,08→1,19 en 2025 ; 6,17→0,69 en 2021).
- **WF3-P : PASS** — C0 reproduit bit-pour-bit les baselines
  (2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 %). Mesure valide.
- **Contrôle d'effet (denied)** : Δdenied > 0 sur 9/9 fenêtres, C1
  +51 à +200, C2 +121 à +282 — le gate passe bien la table au replay.
- **Porte CS4 — éligibles [aucun] sur 9/9 trains** : médiane notional
  par stratégie sous V1-IDENTITY = $0-31, hors [100,400] partout.
  La borne hérite de D12/D2-S où elle qualifiait des **calibrations de
  confiance** (médianes calibrées vivant dans la borne) ; en D2-S le
  binding constraint était dd ≤ 10 %, la borne médiane n'a jamais eu
  à qualifier IDENTITY. Pour des candidats **permission** (confiance
  inchangée), elle disqualifie tout le monde mécaniquement → défaut
  C0 forcé → W2 FAIL (0/5, spread 0,00 %) sans jamais tester H-P1.
- **W1 : PASS** (C0 5/5 trains propres, trivial par défaut).
  **W2 : FAIL** (mécanique, cf. porte ci-dessus). **W3 : PASS**
  (0 violation dd test).
- **Verdict figé a priori : DÉCLASSÉ** — aucune candidat n'étant
  éligible, H-P0 est retenue par le protocole.
- **Lecture honnête** : les deltas bruts favorisent H-P1 (C1 bat C0
  en return sur 6/9, dont les 3 années faibles ; dd réduite 9/9) mais
  restent in-sample — le protocole n'a pas testé l'hypothèse, il l'a
  court-circuitée par une porte inadaptée au type de candidat. Le
  verdict DÉCLASSÉ est consigné tel quel (règle a priori) ; un
  protocole corrigé D3-P2 devra être pré-enregistré avant re-mesure.

### Contrôle d'effet « entrées résiduelles » — FAIL, artefact documenté

C1 laisse 0-4 entrées fillées en BEARISH ; C2 0-1 en RANGE. Cause
prouvée dans le code (replay.ts) : les ordres approuvés au jour T
deviennent `pendingOrders` (L807) et s'exécutent au **candle suivant**
à l'open (`executionCandle.start`, L474-485) — le fill porte
executedAt = T+1. La permission est vérifiée sur le **régime de
décision** (T) ; le contrôle mesurait le **régime au fill** (T+1). Un
ordre approuvé en BULLISH transitionné BEARISH à T+1 est fillé
« BEARISH » sans violation du gate. Le compte (0-4/an) est cohérent
avec le nombre de transitions de régime par an. Ce contrôle sera
reformulé sur le régime de décision au protocole D3-P2.

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
- **Défaut de protocole constaté (post-mortem)** : la porte médiane
  [100,400] est inopérante pour des candidats permission (médianes
  identiques entre candidats, toutes hors borne sous V1-IDENTITY).
  Conservée telle quelle en D3-P pour l'honnêteté a priori ; tout
  protocole futur doit recalibrer ses portes au type de candidat.
- **Latence décision→exécution** : le paper broker exécute les ordres
  au candle suivant (open T+1) — toute attribution « au fill »
  traverse les transitions de régime. Les contrôles d'effet doivent
  cibler le régime de décision, ou borner explicitement les résidus
  attendus par le compte de transitions.
- Attribution par stratégie impossible au fill (Fill sans
  strategyIds, clientOrderId haché) — seule l'attribution par régime
  est disponible ; le contrôle par stratégie reste au niveau denied
  (par stratégie) vs fills (par régime).

## 10. Protocole D3-P2 (pré-enregistré a priori, post-D3-P)

Motif : post-mortem §8 — D3-P a été court-circuité par deux pièces
défaillantes du protocole (porte médiane inopérante pour des candidats
à confiance identique ; contrôle d'effet mesuré au régime du fill,
traversant les transitions par conception du paper broker). D3-P2
corrige **exclusivement** ces deux pièces. L'hypothèse H-P1, les
candidats C0/C1/C2 (§4-5), la config V1, les fenêtres, les folds
propres, les critères W1-W3 (§7) et WF3-P sont **réutilisés à
l'identique**. Le verdict D3-P (DÉCLASSÉ) reste consigné tel quel dans
l'histoire ; D3-P2 est une re-mesure sous protocole amendé, pas une
réinterprétation.

Deltas D3-P → D3-P2 :

1. **Porte de sélection (CS4)** : la borne `médiane notional ∈
   [100,400]` est **retirée**. Justification mécanique : les candidats
   permission ne touchent pas la confiance — leurs médianes de
   requested notional sont identiques entre candidats (mesuré D3-P :
   $0-31 partout) ; la porte ne peut pas discriminer et disqualifie
   mécaniquement tout le monde sous V1-IDENTITY. Portes conservées :
   dd ≤ 10 %, turnover ≤ 10, feeRate ≤ 1 %, run actif, puis argmax
   return train parmi éligibles ; défaut C0. Sous ces portes, C0 est
   de nouveau éligible (dd max 6,88 % mesuré) : W2 devient exécutable
   — le sélecteur peut désormais préférer C1/C2 ou C0 **sur les
   métriques**, ce qui est l'objet du test.
2. **Contrôle d'effet** : mesuré au **régime de décision** (grandeur
   que le gate contrôle réellement), via deux nouveaux compteurs de
   diagnostics `passedByRegime` / `deniedByRegime` exposés par le
   replay (INV-P6 ci-dessous) :
   - `Δdenied = denied(C_k) − denied(C0) > 0` sur chaque fenêtre
     (inchangé) ;
   - `passedByRegime[BEARISH] === 0` pour C1 et C2, et
     `passedByRegime[RANGE] === 0` pour C2, sur chaque fenêtre —
     toute décision approuvée en régime interdit est une violation.
   Les fills résiduels en régimes interdits (1-4/an, mesurés D3-P)
   ne sont plus un critère : artefact de latence documenté §8.
3. **INV-P6 (nouvel invariant de câblage)** : le replay expose les
   compteurs de décisions par régime de décision
   (`passedByRegime`, `deniedByRegime` : Record<RegimeKind, number>),
   distincts de toute attribution au fill. Compteurs purs : aucun
   effet sur les métriques (WF3-P bit-exact reste requis).

Inchangés par ailleurs : 10 fenêtres × 3 candidats (30 runs, 2016
toujours attendue indisponible réseau → 9 fenêtres utiles), folds
propres hors {2023, 2025} (5 attendus, ≥ 4 requis), W1 ≥ 4/5, W2 bat
C0 sur ≥ 4/5 ET spread médian > 0, W3 dd test ≤ 10 %, verdict VALIDÉ
= W1 ∧ W2 ∧ W3 ∧ WF3-P ∧ contrôle d'effet.

## 11. Résultats D3-P2 (campagne du 2026-02-14, 30 runs — 2016 disponible)

Cette fois le protocole a testé l'hypothèse (portes franchissables,
contrôle au régime de décision) :

- **WF3-P : PASS** — C0 reproduit bit-pour-bit les baselines
  (2023 +0,27 % dd 2,93 % ; 2025 +3,63 % dd 3,37 %). Les compteurs
  INV-P6 sont purs : aucune dérive de métriques.
- **Contrôle d'effet : PASS 10/10** — Δdenied rsi > 0 partout
  (C1 +26 à +200, C2 +82 à +282) ; `passedByRegime[BEARISH] = 0`
  pour C1 et C2, `passedByRegime[RANGE] = 0` pour C2, sur les 10
  fenêtres : zéro décision approuvée en régime interdit. Le câblage
  fait exactement ce que le modèle spécifie.
- **Sélection** : éligibles [C0, C1, C2] sur 9/9 trains (porte §10
  opère — dd max 6,88 %, turnover max 6,17, fee 0,06 %). 6 folds
  propres (2016 chargée cette fois ; seuils ≥ 4 inchangés, verdict
  identique sous dénominateur 5 ou 6). Sélections : C0, C2, C1, C2,
  C0, C2 — C2 3/6, C0 2/6, C1 1/6.
- **W1 : FAIL** — aucun candidat atteint 4/6 (C2 max 3/6).
- **W2 : FAIL** — sélectionné bat C0 sur 3/6 tests propres
  (2018 +0,22 pp, 2019 +2,37 pp, 2022 +0,98 pp ; perte fold 2020
  −0,11 pp ; folds 2017/2021 auto-nuls, C0 sélectionné), spread
  médian +0,11 pp.
- **W3 : PASS** — 0 violation dd test.
- **VERDICT D3-P2 : DÉCLASSÉ** — **H-P0 retenue** : le retrait ne
  transfère pas OOS de manière stable sous la règle de sélection
  figée (argmax return train).

### Lecture

L'effet sur les années faibles est **réel et se transfère OOS quand
le candidat est sélectionné** : les 3 folds gagnés sont les fenêtres
2018/2019/2022 (+0,22 à +2,37 pp), la seule perte en compétition est
−0,11 pp (2020). Mais la règle figée ne sait pas **choisir** : C0
gagne les trains forts (2016, 2020), C2 les trains à contenu bearish
(2017, 2019, 2021, 2022) — W1 échoue par instabilité du choix, pas
par absence d'effet. Le fold le plus coûteux : train 2020 (bull)
sélectionne C0 → test 2021 s'effondre à −5,81 % là où C1 aurait fait
−1,17 % ; l'argmax train n'encode pas le risque de bascule de
régime. Near-miss (W1 et W2 à 3/6 pour 4 requis) — la règle a priori
est la règle : DÉCLASSÉ.

Conséquence : l'axe permission par régime (branche 2 du diagnostic)
est **fermé** sous cette famille de règles de sélection. Un
sélecteur conscient du régime de train serait une NOUVELLE hypothèse
(H-P2), à pré-enregistrer avec justification indépendante — pas une
itération de D3-P2. Priorité à la branche 4 : qualité des
signaux/data.

La grille brute (identique D3-P, replays bit-exacts) reste consignée
§8 ; l'infrastructure retenue : câblage `regimePermissions` (INV-P1
à P6) testé et opérationnel, réutilisable tel quel pour tout cycle
futur de permission.
