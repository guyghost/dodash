# Modèle de confirmation de la queue de calibration

Cette étude prolonge `confidence-calibration-confirmation.md` sans modifier son
verdict. Elle évalue une politique distincte, figée avant toute lecture de
nouvelle donnée, pour déterminer si la queue du notionnel demandé par
`POWER_THIRD` reste bornée sur de nouveaux actifs.

## Question et protocole figé

La question est : « `POWER_THIRD` conserve-t-il à la fois l'échelle médiane
confirmée et une queue p95 bornée sur `XTZ-USD` et `ZEC-USD` ? »

Le protocole est déclaré avant le premier chargement de bougies :

- produits : `XTZ-USD` et `ZEC-USD` ;
- folds : `2022-08-19/2023-08-19`, `2023-08-19/2024-08-19`,
  `2024-08-19/2025-08-19` et `2025-08-19/2026-08-19` ;
- profils : `IDENTITY` comme contrôle et `POWER_THIRD` comme seul profil évalué ;
- stratégies calibrées : `ema-cross` et `breakout` ;
- référence inchangée : `rsi-reversion` ;
- décisions `ONE_DAY`, exécution `SIX_HOUR`, marché `SPOT_LONG_ONLY` ;
- capital initial 10 000 USD, cible 1 000 USD, frais 6 bps, slippage 2 bps,
  stop 150 bps, objectif 300 bps et limites de risque inchangées ;
- politique médiane héritée de `confidence-calibration-confirmation.md` ;
- p95 demandé inférieur ou égal à 600 USD pour chaque run/stratégie ;
- ratio `p95 / médiane` inférieur ou égal à 2 pour chaque run/stratégie.

Le plafond absolu représente 60% de la cible de 1 000 USD. Le ratio borne la
dispersion à droite indépendamment de l'échelle absolue. Les deux bornes sont
fixées après l'observation ALGO/FIL mais avant toute lecture XTZ/ZEC. XTZ/ZEC ne
figurent dans aucun artefact ou script local recensé ; cette absence locale ne
prouve pas une ignorance humaine ou externe totale.

## États, événements et transitions

Le runner one-shot suit ces états explicites :

1. `CREATED` reçoit `PROTOCOL_DECLARED` et devient `FROZEN` ;
2. `FROZEN` reçoit `DATASET_LOAD_STARTED` et devient `COLLECTING` ;
3. `COLLECTING` accepte `RUN_RECORDED` uniquement pour une combinaison prévue ;
4. une matrice complète reçoit `EVIDENCE_ASSESSED` et devient
   `TAIL_CONFIRMED` ou `TAIL_NOT_CONFIRMED` selon le cœur pur ;
5. une preuve absente, dupliquée ou incohérente reçoit `EVIDENCE_REJECTED` et
   devient `INVALID_EVIDENCE` ;
6. `TAIL_CONFIRMED` ou `TAIL_NOT_CONFIRMED` reçoit `ARTIFACT_WRITTEN` et devient
   `COMPLETED`, toujours avec le statut `RESEARCH_ONLY`.

`INVALID_EVIDENCE` est terminal et n'écrit pas de nouvel artefact final. Il
n'existe aucun remplacement de produit, retry décisionnel, fallback de
timeframe, changement de seuil ou re-sélection de profil.

## Grain et validité de l'évidence

Le grain reste `profil × produit/fold × stratégie calibrée`. La preuve contient
exactement 32 observations et huit invariants de run, avec les mêmes règles de
validité, populations de signaux, benchmark et référence RSI que le modèle de
confirmation médiane.

Le cœur de queue réutilise d'abord le cœur de confirmation médiane comme
validateur et sous-décision. Une preuve invalide reste
`INVALID_CONFIDENCE_CALIBRATION_TAIL_CONFIRMATION_EVIDENCE`; elle ne peut pas
devenir un verdict négatif valide.

Pour chaque observation active `POWER_THIRD`, le cœur calcule
`p95RequestedNotional / medianRequestedNotional`. Les distributions nulles ou
non finies sont déjà interdites par le modèle parent.

## Politique de confirmation de queue

Le verdict est `TAIL_CONFIRMED` si et seulement si :

1. la même preuve obtient `CONFIRMED` sous la politique médiane existante ;
2. chaque p95 `POWER_THIRD` est inférieur ou égal à 600 USD ;
3. chaque ratio `p95 / médiane` `POWER_THIRD` est inférieur ou égal à 2.

Une preuve valide qui échoue produit `TAIL_NOT_CONFIRMED` avec une liste fermée
de motifs : `BASE_CONFIRMATION_FAILED`, `P95_NOTIONAL_LIMIT` ou
`P95_MEDIAN_RATIO_LIMIT`. Tous les motifs applicables sont conservés.

Le PnL, rendement, Sharpe, win rate et profit factor sont descriptifs et absents
du cœur de décision. Un verdict ne déclenche aucune recherche de seuil.

## Effets de bord

Le cœur est synchrone et pur. Le shell est seul autorisé à charger Coinbase,
exécuter les backtests, horodater, journaliser et écrire l'artefact JSON par
remplacement atomique. Aucun LLM ne produit un événement ou une transition.

## Invariants

1. Produits, folds, profils et bornes de queue sont figés avant les données.
2. Le modèle de queue ne change pas le verdict historique ALGO/FIL.
3. Le modèle parent possède la validation de la matrice et de l'échelle médiane.
4. Toutes les observations `POWER_THIRD` ont le même poids dans les maxima.
5. Les bornes 600 USD et 2 sont inclusives.
6. Une preuve invalide ne peut produire aucun verdict de queue.
7. Le PnL ne peut modifier le verdict ni sélectionner un autre profil.
8. Aucun résultat ne peut activer le trading live.
9. L'artefact conserve datasets, hashes, paramètres, résultats et assessment.
