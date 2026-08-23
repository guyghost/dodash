# Diagnostic : attribution des pertes en années faibles

Statut : MESURÉ

## 1. Contexte et question

Après la fermeture de l'axe sizing (D12 statique et D2-S conditionné tous
deux DÉCLASSÉ), la config de référence est V1-IDENTITY : gate
EMA_THRESHOLD 100/5/3, exits REGIME_CONDITIONAL (bull NONE, autres
300/600), calibration IDENTITY. Sur la grille D2-S, 3 fenêtres sur 10
sont négatives : 2019 −2,60 %, 2021 −5,81 %, 2022 −1,03 % — avec des
drawdowns contents (≤ 6,9 %).

Question : **où se perd l'argent les années faibles** — par régime, par
type de flux (exit protectif vs directionnel), par stratégie — et
existe-t-il un levier chirurgical modélisable (gate, stratégie, exit),
ou l'edge de base est-il simplement insuffisant ?

Ce document est un diagnostic mesuré (comme `bull-alpha-diagnosis.md`),
pas un modèle de comportement : il motive le prochain cycle
Model → Review → Implement → Verify.

## 2. Données

BTC-USD ONE_DAY, les 10 fenêtres annuelles D2-S
(`[YYYY-08-21 → YYYY+1-08-21]` UTC), config V1 bit-identique au
walk-forward D2-S côté C_IDENTITY (mêmes constantes, pré-validation spot
et fenêtre dailyPnl structurelles).

Fenêtres cibles : **faibles** = 2019, 2021, 2022 ; **fortes de
référence** = 2016, 2020, 2024.

## 3. Décompositions spécifiées a priori

- **M1 — jours par régime** : timeline reconstituée en rejouant
  `regimeFilterMachine` sur les snapshots d'indicateurs (méthode
  `regime-days.ts`) ; jours et % par régime par fenêtre.
- **M2 — PnL réalisé par régime de clôture** : chaque `PaperTrade` est
  attribué au **dernier régime connu au timestamp du fill** (rejeu des
  observations dans l'ordre, arrêt au dernier `candleClosedAt` ≤
  `executedAt`). Choix a priori : le PnL est « réalisé en régime X » ;
  le régime d'entrée peut différer, cette limite est assumée (§7).
  **INV-D1 (complétude)** : la somme des PnL par régime et par flux est
  égale au PnL réalisé total de la fenêtre (somme des `realizedPnl` de
  tous les trades), au centime près — et non au `metrics.totalReturn`,
  qui inclut notamment la position restante non réalisée.
- **M3 — flux exit vs directionnel** : un trade est protectif si son
  `fill.clientOrderId` commence par `${runId}:protective:` (convention
  d'implémentation du replay, § code replay.ts createOrderIntent
  protective) ; les autres sont directionnels. PnL et effectifs par
  régime.
- **M4 — stops vs takes par régime** : via `protectiveExits[]`
  (`kind` stop/take, `triggeredAt`) croisé avec la timeline M1 ; win
  rate par régime.
- **M5 — attribution par stratégie, solo + ablation** :
  (a) **solo** : le rapport de suite produit déjà un scénario par
  stratégie seule (rsi-reversion, ema-cross, breakout) — lu sans coût
  supplémentaire ; (b) **ablation** : pour S ∈ {ema-cross, breakout,
  rsi-reversion}, run de l'ensemble sans S (replay direct avec
  `createStrategyRegistry` réduit, pattern des tests), Δreturn =
  return(sans S) − return(complet), sur les 3 fenêtres faibles + 3
  fortes. Les contributions ne sont pas supposées additives
  (interactions entre stratégies non décomposées) ; l'ordre d'ablation
  est un-ablation à la fois depuis l'ensemble complet.
  **INV-D2 (non-dérive)** : le run complet de chaque fenêtre reproduit
  bit-pour-bit la ligne IDENTITY de la grille D2-S.

## 4. Arbre de lecture (décisions a priori)

Une cellule (régime × flux) est **dominante** pour une fenêtre si elle
concentre ≥ 60 % de la perte nette annuelle (somme des PnL négatifs de
la fenêtre, en valeur absolue au dénominateur : |perte nette| de la
cellule / |perte nette| totale de la fenêtre).

1. Perte concentrée sur les fills **clôturés en BEARISH** → le gate
   bear existant laisse passer un anti-edge → candidat prochain cycle :
   resserrer la permission bear du gate (nouveau modèle, nouveau cycle).
2. Perte en **RANGE** portée par une stratégie (M5 la désigne) →
   candidat : conditionner cette stratégie au régime (miroir
   regime-sizing, un seul levier).
3. Perte dominée par les **stops protectifs** (M3/M4) en range/bear →
   levier exit déjà exploré (regime-exit v3 : échec a priori) → axe
   probablement fermé, à consigner honnêtement.
4. Perte **diffuse** (aucune cellule dominante) → pas de levier
   chirurgical : l'edge de base est le problème → priorité aux
   signaux/data, pas au plumbing.

## 5. Livrables

- `packages/backtest/scripts/weak-year-attribution.ts` (M1-M5, une
  exécution, sortie tabulaire).
- Ce document complété : §6 Résultats, statut → MESURÉ.

## 6. Résultats

Exécution : `packages/backtest/scripts/weak-year-attribution.ts`
(42 replays, 7 par fenêtre : ensemble + 3 solo + 3 ablations).
**INV-D1 PASS** (Σ cellules = Σ realizedPnl au centime, 6/6 fenêtres) ;
**INV-D2 PASS** (ret ensemble = ligne IDENTITY D2-S, 6/6 fenêtres).

### 6.1 M1 — jours par régime

| Fenêtre | warmUp | BULLISH | BEARISH | RANGE |
|---|---|---|---|---|
| 2019 FAIBLE | 4 | 140 | 114 | 81 |
| 2021 FAIBLE | 5 | 92 | **200** | 41 |
| 2022 FAIBLE | 4 | 127 | 79 | **128** |
| 2016 FORTE | 5 | **251** | 26 | 56 |
| 2020 FORTE | 4 | **213** | 83 | 38 |
| 2024 FORTE | 5 | **171** | 51 | 111 |

Les années faibles sont bear/range-dominées (2019 : 195 j ; 2021 :
241 j ; 2022 : 207 j), les fortes bull-dominées.

### 6.2 M2+M3 — PnL ($) par régime × flux (ensemble V1-IDENTITY)

| Fenêtre | BULL dir | BEAR dir | RANGE dir | BULL prot | BEAR prot | RANGE prot | Σ trades |
|---|---|---|---|---|---|---|---|
| 2019 | −3,36 | 0,00 | −0,25 | 0,00 | **−214,74** | −40,77 | −259,12 |
| 2021 | −2,62 | 0,00 | −6,54 | 0,00 | **−566,75** | −5,00 | −580,90 |
| 2022 | −0,03 | 0,00 | +26,23 | 0,00 | −12,89 | **−121,15** | −107,85 |
| 2016 | −0,98 | 0,00 | +11,27 | 0,00 | +15,68 | **+176,46** | +202,44 |
| 2020 | 0,00 | 0,00 | 0,00 | 0,00 | +10,56 | **+1111,00** | +1121,55 |
| 2024 | −0,19 | 0,00 | −0,06 | 0,00 | +48,64 | **+152,84** | +201,24 |

Structure mécanique (à lire avant toute interprétation) : le flux
directionnel est ≈ 0 $ partout car les positions de V1 se clôturent
presque exclusivement via exits protectifs — le flux protective est le
lieu de réalisation de la quasi-totalité du PnL, gains compris.

### 6.3 M4 — stops/takes et win rates (flux protectif)

| Fenêtre | BEAR stops/takes (wr) | RANGE stops/takes (wr) |
|---|---|---|
| 2019 | 18/7 (28 %) | 4/0 (0 %) |
| 2021 | 25/7 (22 %) | 2/0 (0 %) |
| 2022 | 6/3 (33 %) | 7/1 (13 %) |
| 2016 | 2/1 (33 %) | 1/3 (75 %) |
| 2020 | 9/5 (36 %) | 0/1 (100 %) |
| 2024 | 2/2 (50 %) | 4/4 (50 %) |

Années faibles : stops ≫ takes en bear/range (wr 0-33 %). Années
fortes : takes ≥ stops (2016 RANGE 75 %, 2020 le gain de l'année est
UN seul take RANGE +1 111 $ — fragilité n=1 consignée §7).

### 6.4 M5 — solo et ablations (ret %)

| Fenêtre | ensemble | solo rsi | solo ema | solo brk | Δret sans rsi | sans ema | sans brk |
|---|---|---|---|---|---|---|---|
| 2019 | −2,60 | **−2,46** | 0,00 | −0,14 | +2,46 | −0,00 | +0,14 |
| 2021 | −5,81 | **−5,67** | 0,00 | −0,14 | +5,67 | 0,00 | +0,14 |
| 2022 | −1,03 | **−0,98** | 0,00 | −0,05 | +0,98 | 0,00 | +0,05 |
| 2016 | +2,35 | +0,71 | 0,00 | +1,64 | −0,71 | 0,00 | −1,64 |
| 2020 | +11,33 | +0,11 | 0,00 | +11,22 | −0,11 | 0,00 | −11,22 |
| 2024 | +2,01 | +1,72 | 0,00 | +0,29 | −1,72 | 0,00 | −0,29 |

rsi-reversion porte la quasi-totalité de la perte des années faibles
(solo ≈ ensemble) ; son retrait améliore les 3 fenêtres faibles
(+2,46/+5,67/+0,98) et ne coûte que −0,71/−0,11/−1,72 aux fortes.
ema-cross est inerte (0,00 % sur les 6 fenêtres — jamais de signal
exécutable dans V1 daily).

### 6.5 Application de l'arbre §4

- 2019 : dominante **BEARISH|protective** (83 % de la perte nette) → branche 1.
- 2021 : dominante **BEARISH|protective** (96 %) → branche 1.
- 2022 : dominante **RANGE|protective** (90 %) → branche 2, M5 désigne rsi-reversion.
- 2016/2024 : dominante BULLISH|directional mais pertes minimes (< 1 $)
  dans des années gagnantes — sans objet. 2020 : diffuse (branche 4
  locale, sans perte à expliquer).

Lecture conjointe M3+M4+M5 : la perte des années faibles est le
résultat de **rsi-reversion émettant des BUY en régime BEARISH/RANGE
prolongé** — entrées sur oversold dans une tendance baissaire,
clôturées par stops protectifs (wr 22-33 %). Le flux « protective »
n'est pas un levier exit : c'est le lieu de réalisation mécanique du
PnL, et l'axe exit est déjà fermé (regime-exit v3 DÉCLASSÉ ; élargir
les stops bear a échoué). Le levier chirurgical est à la **source** :
la permission d'émettre de rsi-reversion selon le régime
(convergence branches 1+2 ; miroir du conditionnement de sizing mais
sur le signal, un seul levier : BEARISH → OFF, autres → ON).

Verdict : **branche 2 (avec composante branche 1)** — prochain cycle
candidat : modèle de permission par stratégie × régime, rsi-reversion
désactivée en BEARISH, évalué par walk-forward avec la même porte de
risque CS4. Observations secondaires : ema-cross inerte (candidate au
retrait du scénario de référence) ; gain 2020 concentré sur un unique
take (fragilité).

## 7. Limites

- Attribution au régime de **clôture** du fill : un trade ouvert en
  BULLISH et stoppé après bascule RANGE est compté RANGE. Alternative
  (régime d'entrée) rejetée a priori : le PnL se réalise à la clôture.
- M5 contrefactuelle : une ablation peut interagir (une stratégie
  masque les signaux d'une autre via l'allocation) — les Δ sont des
  contributions marginales à partir de l'ensemble complet, pas une
  décomposition additive.
- Le critère de dominance à 60 % est fixé a priori pour interdire la
  lecture post hoc des cellules.
- Le flux protective concentre mécaniquement tout le PnL réalisé
  (les clôtures directionnelles sont rarissimes dans V1) : M3 sépare
  par fill, pas par causalité d'entrée. L'attribution causale à
  rsi-reversion repose sur M5 (solo/ablation), pas sur M3 seul.
- Le gain 2020 (+1 111 $) provient d'un unique take protective RANGE
  (n=1) : la fragilité de cette fenêtre forte limite la précision des
  comparaisons de brk/rsi qui y reposent.
