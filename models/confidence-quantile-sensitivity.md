# Modèle de sensibilité de la queue aux estimateurs de quantile

Cette étude explique si le dépassement marginal de la borne relative observé
sur XTZ/ZEC dépend de la convention de p95, sans modifier la borne `2`, puis
répète la politique choisie sur GRT/MANA. Elle ne réinterprète aucun verdict
historique, ne recherche aucun nouveau profil et n'autorise pas le trading live.

## Question et protocole figé

Avant toute lecture de bougies GRT/MANA, le protocole fixe :

- probabilité : `0.95` ;
- estimateurs comparés sur les mêmes échantillons : `LINEAR_R7`,
  `NEAREST_RANK`, `LOWER` et `HIGHER` ;
- estimateur unique appliqué aux nouveaux actifs : `NEAREST_RANK` ;
- justification ex ante : quantile empirique conservateur, toujours égal à une
  observation et ne sous-estimant pas le rang demandé ;
- bornes inchangées : p95 absolu `<= 600 USD` et p95/médiane `<= 2` ;
- médiane du dénominateur : `LINEAR_R7` à `0.5`, convention déjà publiée ;
- référence de sensibilité : `XTZ-USD` et `ZEC-USD` ;
- confirmation externe : `GRT-USD` et `MANA-USD`, absents des artefacts et
  scripts d'étude locaux lors du pré-enregistrement ;
- folds : `2022-08-19/2023-08-19`, `2023-08-19/2024-08-19`,
  `2024-08-19/2025-08-19` et `2025-08-19/2026-08-19` ;
- profils exécutés : contrôle `IDENTITY` et profil figé `POWER_THIRD` ;
- stratégies calibrées : `ema-cross` et `breakout`, référence inchangée
  `rsi-reversion` ;
- décisions `ONE_DAY`, exécution `SIX_HOUR`, marché `SPOT_LONG_ONLY`, capital,
  sizing, coûts, sorties protectrices et limites de risque identiques à l'étude
  XTZ/ZEC.

Le choix `NEAREST_RANK` ne dépend donc ni des résultats de sensibilité, ni des
données GRT/MANA. Si un dataset déclaré est indisponible, le protocole devient
invalide au lieu de substituer un actif.

## Historique de pré-enregistrement

Une première instance avait déclaré `MKR-USD` et `COMP-USD`. Elle a atteint
`INVALID_EVIDENCE` avant tout verdict et sans artefact final lorsque Coinbase a
retourné `INCOMPLETE_HISTORICAL_DATA` pour MKR sur le fold 2025–2026. Aucun
résultat de queue MKR/COMP n'a été produit ou consulté. L'instance courante est
un nouveau protocole, déclaré après cet échec mais avant toute lecture GRT/MANA.
Elle conserve sans modification les estimateurs, la règle sélectionnée, les
bornes, folds, profils et paramètres. Ce redémarrage explicite n'est pas une
transition ni une substitution dans l'instance devenue terminale.

## Définitions fermées

Pour une série finie, positive et triée `x[0..n-1]` et `q` dans `[0, 1]` :

- `LINEAR_R7` interpole à la position `(n - 1)q` ;
- `NEAREST_RANK` retourne `x[max(0, ceil(nq) - 1)]` ;
- `LOWER` retourne `x[floor((n - 1)q)]` ;
- `HIGHER` retourne `x[ceil((n - 1)q)]`.

Les bornes sont inclusives. Une observation active doit conserver tous ses
notionnels demandés bruts ; leur nombre doit égaler `activeSignalCount`. Une
observation inactive exige un tableau vide et une médiane/p95 absents.

## États, événements et transitions

Le runner one-shot suit :

1. `CREATED` reçoit `PROTOCOL_DECLARED` et devient `FROZEN` ;
2. `FROZEN` reçoit `REFERENCE_LOAD_STARTED` et devient
   `REFERENCE_COLLECTING` ;
3. une matrice XTZ/ZEC complète reçoit `REFERENCE_ASSESSED` et devient
   `REFERENCE_READY` ; son résultat ne peut plus modifier l'estimateur ;
4. `REFERENCE_READY` reçoit `EXTERNAL_LOAD_STARTED` et devient
   `EXTERNAL_COLLECTING` ;
5. une matrice GRT/MANA complète reçoit `EXTERNAL_ASSESSED` et devient
   `TAIL_CONFIRMED` ou `TAIL_NOT_CONFIRMED` selon `NEAREST_RANK` ;
6. le verdict reçoit `ARTIFACT_WRITTEN` et devient `COMPLETED`, statut
   `RESEARCH_ONLY` ;
7. chargement, replay, matrice, invariant ou échantillon invalide reçoit
   `EVIDENCE_REJECTED` et devient `INVALID_EVIDENCE`, terminal sans nouvel
   artefact final.

Il n'existe ni retry décisionnel, ni changement de borne, d'estimateur, de
produit ou de fold après `FROZEN`.

## Grain et validation de l'évidence

Chaque population (`REFERENCE`, `EXTERNAL`) contient exactement 32
observations : deux profils × huit run keys × deux stratégies. Le grain est
`profil × produit/fold × stratégie`. Chaque observation conserve les compteurs,
les échantillons de notionnel demandé, le taux de plafond, le taux de rejet
risque, le drawdown, le turnover et les frais.

Le cœur reconstruit médiane et p95 R7 depuis les échantillons, puis délègue au
modèle de confirmation parent la couverture, l'échelle médiane, les garde-fous
et les invariants de population. Les compteurs de signaux, le benchmark et RSI
doivent rester identiques entre profils. L'absence ou la duplication d'une case,
un échantillon invalide ou une divergence invalide l'évidence.

## Décision

Pour chaque estimateur, le cœur calcule sur les 16 cases `POWER_THIRD` : p95,
ratio à la médiane R7, maxima et nombre de dépassements. Un estimateur passe si
et seulement si la confirmation parent est `CONFIRMED` et si toutes ses cases
respectent les deux bornes.

La sensibilité XTZ/ZEC est descriptive : `AGREEMENT` si les quatre verdicts sont
identiques, `DISAGREEMENT` sinon. Elle n'a aucun effet sur la politique figée.
Le verdict externe est exclusivement celui de `NEAREST_RANK`, avec les motifs
fermés `BASE_CONFIRMATION_FAILED`, `P95_NOTIONAL_LIMIT` et
`P95_MEDIAN_RATIO_LIMIT`.

Le PnL, rendement, Sharpe, win rate et profit factor sont absents du cœur de
décision.

## Effets de bord et invariants

Le cœur est synchrone, pur et sans I/O. Le shell seul charge Coinbase, exécute
les suites, journalise et écrit un JSON atomique après deux preuves valides.

1. Estimateur choisi, probability et bornes sont figés avant GRT/MANA.
2. Les quatre estimateurs consomment exactement les mêmes échantillons.
3. La médiane R7 reste le dénominateur commun ; la borne relative reste `2`.
4. Le résultat XTZ/ZEC ne peut re-sélectionner l'estimateur.
5. La politique GRT/MANA est identique à la politique XTZ/ZEC hors actifs.
6. Une matrice invalide ne produit ni accord, ni verdict externe.
7. Les verdicts ALGO/FIL et XTZ/ZEC antérieurs restent inchangés.
8. Aucun résultat ne change le CLI général, une configuration live ou un état
   de trading.
