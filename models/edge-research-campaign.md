# Modèle — Campagne d'edge multi-régimes (grille v2, DAO #40)

Statut : MODÉLISÉ — grille figée avant exécution (C1). Périmètre
**lecture-seule côté trading** (C2) : aucun code de stratégie, de machine ou de
permission n'est modifié ; aucune activation, aucune transition vers le live.
Les seuls ajouts de code de cette campagne sont un script d'analyse
(`packages/backtest/scripts/edge-research-grid.ts`) et un rapport versionné
(`docs/analysis/edge-research-2026-09.md`).

La grille de ce fichier est **figée avant le premier run** : l'historique git
doit le prouver (commit « models » strictement antérieur au commit
« exécution + rapport »). Aucune cellule ne peut être ajoutée, retirée ou
re-paramétrée après coup.

## 1. Objet

Exécuter une grille de backtests pré-déclarée couvrant 2021→2026 et ses
découpes annuelles, évaluer chaque cellule exclusivement en **métriques
primaires absolues** (évaluation v2, `models/backtest-diagnostics.md`), et
produire un rapport honnête : verdicts par cellule, candidates éventuelles
avec protocole OOS obligatoire, cellules non exécutables consignées.

Motivation (constats de l'analyse du 2026-09-04) : toutes les fenêtres
mesurées jusqu'ici étaient baissières et courtes (365 j) ; IDENTITY est
sous-exposant (notional médian 0,77 $ pour ema-cross) ; aucun edge démontré.
La campagne #40 (rendue possible par #37 : run 5 ans ~162 s) teste les
stratégies existantes sur un spectre pluri-régimes, sans rien changer au
trading.

## 2. Socle (tout mergé sur main)

- **#37** : backtest 5 ans ONE_DAY en ~162 s, bit-exact (INV-27) ;
  estimations de timebox de cette campagne dérivées de
  `docs/analysis/analyse-dao-37-perf-backtest.md` (préparation ~28 s par
  365 bougies, ~165 s par 1 829 bougies, replay ~3 s).
- **#39** : évaluation v2 — métriques primaires absolues, excess rétrogradé
  en contextuel, régime du benchmark calculé au seuil figé zéro
  (`BENCHMARK_REGIME_THRESHOLD`, `packages/backtest/src/evaluation-v2.ts`).
- **#38** : seuil funding-trend figé au percentile p75
  (`FUNDING_TREND_ENTER_THRESHOLD`, `models/funding-rate-strategy.md` §5),
  variant in-sample non validé OOS (INV-F9).
- Calibration POWER_THIRD : bande d'exposition [100 ; 400] $ verdict
  CONFIRMED (`models/confidence-calibration-confirmation.md`) — la
  confirmation porte sur l'exposition, pas la rentabilité
  (`pnlUsedForVerdict: false`).
- Fixtures réelles dao30/dao35 (prix BTC-USD + funding Hyperliquid,
  empreintes SHA-256 vérifiées à la lecture).

## 3. Grille figée

### 3.1 Actifs

- **BTC-USD** — actif primaire.
- **ETH-USD** — le runner couvre tout produit Coinbase (`--product`) ; la
  disponibilité des bougies journalières ETH-USD a été vérifiée contre
  l'API réelle AVANT le gel de la grille. Toute cellule dont le dataset est
  indisponible ou incomplet est consignée **non exécutable avec la raison**
  (C3) — jamais substituée, jamais retirée de la grille.

### 3.2 Fenêtres (ONE_DAY, bornes UTC, borne de fin exclusive)

| Fenêtre | Début | Fin (exclusive) | Bougies attendues | Note |
|---|---|---|---|---|
| FULL | 2021-01-01 | 2026-09-04 | 2 072 | fenêtre complète |
| Y2021 | 2021-01-01 | 2022-01-01 | 365 | |
| Y2022 | 2022-01-01 | 2023-01-01 | 365 | |
| Y2023 | 2023-01-01 | 2024-01-01 | 365 | |
| Y2024 | 2024-01-01 | 2025-01-01 | 366 | |
| Y2025 | 2025-01-01 | 2026-01-01 | 365 | |
| Y2026 | 2026-01-01 | 2026-09-04 | 246 | partielle ; dernier jour clôturé 2026-09-03 |

- La découpe est **calendaire et figée** : aucune fenêtre n'est choisie
  après lecture des données, aucune fenêtre n'est sélectionnée par régime.
- La lecture par régime est **automatique et calculée** : chaque fenêtre
  reçoit le régime de son benchmark buy-and-hold au seuil figé zéro de
  l'évaluation v2 (`>= 0` → HAUSSIER, `< 0` → BAISSIER). Le régime n'est
  jamais déclaré à la main.
- Y2026 est partielle : ses verdicts sont absolument valides mais sa
  longueur (246 bougies) limite la comparabilité directe avec les années
  pleines ; le rapport le mentionne.

### 3.3 Calibrations

- **IDENTITY** (défaut) et **POWER_THIRD** (`--confidence-calibration` /
  config suite). Conformément au protocole
  (`models/confidence-calibration.md`), la calibration s'applique à
  `ema-cross` et `breakout` ; **`rsi-reversion` n'est pas calibrée** : ses
  paires de cellules IDENTITY/POWER_THIRD sont identiques par construction.
  Cette duplication est déclarée ici, avant exécution ; pour les candidates,
  les cellules rsi sont **dédupliquées** par (stratégie, fenêtre, coûts,
  actif).

### 3.4 Coûts de transaction

- **×1** : frais 6 bps, slippage 2 bps (défauts du dépôt).
- **×2** : frais 12 bps, slippage 4 bps. Seul `broker` varie ; toute autre
  dimension de la config est inchangée.

### 3.5 Stratégies

- **Cellules primaires** : `rsi-reversion`, `ema-cross`, `breakout` —
  paramètres défauts du dépôt (RSI 30/70, lookback breakout 20, EMA défauts),
  registre = suite standard (`runBacktestSuite`). Aucun réglage nouveau.
- **Cellules informationnelles** (hors classement des candidates, ne
  produisent jamais de verdict d'edge) :
  - `ensemble` : scénario complémentaire produit par chaque run de la suite ;
  - `funding-trend` p75 : rejeu sur les fixtures réelles dao30 (fenêtre H12
    2025-09-01→2026-09-01) et continuation dao35 (préfixe 90 bougies + OOS
    2026-09-01→2026-09-04), constante figée
    `FUNDING_TREND_ENTER_THRESHOLD` re-vérifiée contre l'annexe #35.
    **0 trade attendu** (constat de structure de signe pré-enregistré au
    §5 du modèle funding-rate-strategy). Le rejeu passe par le chemin de
    repli sans indicateurs préparés : les snapshots préparés (#37) ne
    portent pas `fundingAvg`, un 0 trade obtenu autrement serait un artefact
    de mécanique, pas un résultat.

### 3.6 Configuration commune (identique aux défauts du CLI)

Capital 10 000 $ ; notional signal cible 1 000 $ ; risque défauts CLI
(maxOrderNotional 2 000 $, maxPositionNotional 10 000 $, maxGrossExposure
20 000 $, maxDailyLoss 1 000 $, cooldown 0, SL 150 bps / TP 300 bps) ;
exécution `NEXT_CANDLE_OPEN` ; spot long-only ; indicateurs
`DEFAULT_INDICATOR_CONFIG`. Aucune sortie protectrice conditionnelle, aucun
filtre de régime : la grille mesure les stratégies telles que le dépôt les
exécute.

### 3.7 Dénombrement exact (figé)

- Runs de suite : 2 actifs × 7 fenêtres × 2 calibrations × 2 coûts = **56**.
- Cellules primaires : 56 × 3 stratégies = **168**.
- Cellules informationnelles : 56 scénarios `ensemble` + 2 rejeux
  `funding-trend` = **58**.

## 4. Métriques et verdicts par cellule

Chaque cellule primaire rapporte les **métriques primaires v2** (seules
habilitées à soutenir un verdict) : PnL absolu net ($ et % du capital),
réalisé et latent distincts, win rate liquidatif (INV-26), drawdown maximal,
Sharpe annualisé, turnover, frais payés. L'excess vs benchmark est rapporté
uniquement comme métrique contextuelle, toujours accompagné du régime
calculé de la fenêtre.

Verdict par cellule — fonction figée, appliquée dans cet ordre :

1. **inactif** (exposition quasi nulle) : `tradeCount = 0` **ou** médiane du
   notional demandé (diagnostic du run) `< 100 $` — borne basse de la bande
   d'exposition confirmée [100 ; 400] $
   (`models/confidence-calibration-confirmation.md`) ;
2. **edge démontré** — étiquette de **criblage**, jamais une conclusion :
   cellule active **et** PnL absolu net `> 0` **et** Sharpe `> 0` ;
3. **non démontré** : tout autre cas.

Toute cellule « edge démontré » est une **candidate** et déclenche
obligatoirement le protocole OOS du §6 — aucune exception (C4). Un échec de
cellule (dataset indisponible, échec de replay) est consigné avec sa raison ;
aucune valeur n'est substituée (C3).

## 5. Multiplicité des tests (C4)

La grille comprend **168 cellules primaires** (+ 58 informationnelles). Sous
l'hypothèse nulle — PnL d'espérance nulle, indépendance approximative des
cellules — environ **la moitié des cellules (~84) affichent un PnL positif
par pur hasard**, et la probabilité qu'au moins une cellule passe le
criblage « PnL > 0 et Sharpe > 0 » tend vers 1. Le **risque de faux positifs
multiples est la menace principale** de cette campagne : avec 168 essais, un
résultat positif isolé n'a presque aucune valeur de preuve.

Conséquences figées avant exécution :

1. l'étiquette « edge démontré » est un criblage, jamais un verdict final ;
2. **toute** candidate est soumise à la confirmation OOS du §6, sans
   exception ;
3. aucun seuil de la grille (verdicts, OOS) ne sera ajusté après lecture des
   résultats ;
4. aucune activation de stratégie, aucune transition vers paper/live ne peut
   résulter de cette grille ; une candidate confirmée OOS resterait soumise à
   une proposition séparée.

## 6. Protocole OOS successor pré-enregistré

Pour chaque candidate (actif A, stratégie S, fenêtre W, calibration C,
coûts K) :

1. **Fenêtre successor figée** : `[2026-09-05, 2027-09-05)` en ONE_DAY —
   données inexistantes au moment du gel (aucune fuite possible), exécutable
   dès disponibilité. Configuration **exactement** celle de la cellule
   candidate (mêmes défauts, même calibration, mêmes coûts).
2. **Seuils de confirmation figés** (métriques primaires uniquement, tous
   requis) :
   - PnL absolu net `> 0` ;
   - Sharpe annualisé `>= 0,5` ;
   - win rate liquidatif `>= 50 %` ;
   - drawdown maximal `<= 20 %` du capital ;
   - turnover `>= 10 %` du capital (preuve d'activité réelle) ;
   - nombre de trades `>= 20` ;
   - médiane du notional demandé `>= 100 $` (bande d'exposition).
3. **Contrôles immédiats** (nécessaires, non suffisants) :
   - réplication **cross-actif** : même config sur l'autre actif, même
     fenêtre — même signe de PnL (BTC et ETH partagent leur régime ; ce
     contrôle ne remplace pas l'OOS temporel) ;
   - cohérence de **signe des deux bras de coûts** (×1 et ×2) de la fenêtre
     d'origine — un PnL qui s'inverse en doublant les frais n'est pas
     robuste.
4. **Rejet** : un seul critère manquant ⇒ candidate rejetée, sans
   recalibrage des seuils. Une candidate rejetée ne peut être retentée que
   sur la fenêtre successor suivante (`[2027-09-05, 2028-09-05)`), une
   seule fois.

La justification des seuils est volontairement simple : des valeurs
nettement positives mais atteignables au vu des mesures existantes ; ce qui
fait leur validité est leur **gel antérieur à toute lecture OOS**, pas leur
valeur exacte.

## 7. Exécution et timebox

- Estimations (#37, machine locale) : préparation ~28 s par 365 bougies,
  ~165 s par 1 829 bougies, replay ~3 s, fetch Coinbase réel inclus.
  Budget prévu : 8 runs FULL (~175-185 s chacun) + 40 runs annuels
  (~35-40 s) + 8 runs Y2026 (~20-25 s) + 2 rejeux funding-trend (chemin de
  repli, ~75 s et ~15 s) ⇒ **~55-65 minutes** hors échecs. Les échecs sont
  consignés et la grille continue.
- **Un dataset par (actif, fenêtre)**, fetché une fois et partagé entre les
  4 bras (calibration × coûts) : comparabilité maximale, empreinte SHA-256
  consignée dans chaque artefact.
- **Reprise** : un artefact de run existant est rechargé, pas rejoué ; la
  reprise ne modifie aucune valeur (seul l'horodatage d'exécution diffère).
- Script d'analyse (seul ajout de code, C2) :
  `packages/backtest/scripts/edge-research-grid.ts`, exécution
  `pnpm dlx tsx packages/backtest/scripts/edge-research-grid.ts` ;
  artefacts dans `packages/backtest/.artifacts/studies/edge-grid-2026-09/`
  (hors dépôt, `.artifacts/` est ignoré).
- Cellule non exécutable (dataset indisponible/incomplet, échec de replay)
  ⇒ statut `ECHEC` + raison dans l'artefact consolidé et le rapport ; la
  cellule n'est ni retirée de la grille ni remplacée (C3).

## 8. Rapport

`docs/analysis/edge-research-2026-09.md`, versionné, contient :

- le tableau de verdicts par cellule (métriques primaires + régime calculé) ;
- le décompte des cellules exécutées / échouées / non exécutables avec
  raisons ;
- le classement honnête des candidates éventuelles, chacune avec les
  conditions exactes de son protocole OOS (§6) ;
- la mention explicite du risque de faux positifs multiples (§5) ;
- si AUCUNE candidate : le rapport le dit clairement — c'est un résultat
  valide.

## 9. Invariants

1. La grille (axes, bornes, règles de verdict, seuils OOS) est figée dans ce
   fichier avant le premier run ; l'historique git le prouve (commit models
   strictement antérieur au commit d'exécution).
2. Aucune cellule n'est ajoutée, retirée ou re-paramétrée après le premier
   run ; une cellule impossible est consignée non exécutable avec la raison.
3. Le régime d'une fenêtre est calculé au seuil figé zéro à partir du
   benchmark de la fenêtre ; il n'est jamais déclaré à la main.
4. Les verdicts n'utilisent que les métriques primaires ; l'excess n'est
   jamais rapporté sans le régime calculé.
5. Toute candidate est soumise au protocole OOS §6 ; aucune exception (C4).
6. Tous les chiffres du rapport proviennent des sorties réelles des outils
   du dépôt ; un échec est consigné, jamais substitué (C3).
7. Aucune modification de code de stratégie, de machine ou de permission ;
   aucune activation ; les scripts d'analyse sont les seuls ajouts de code
   (C2).
8. Les cellules rsi-reversion sont invariantes par calibration ; une
   candidate rsi est dédupliquée par (stratégie, fenêtre, coûts, actif).
9. Les cellules informationnelles (`ensemble`, `funding-trend`) ne
   produisent ni verdict d'edge ni candidate.
10. Ce fichier ne contient aucune valeur issue d'un run de la grille : il
    précède l'exécution.
