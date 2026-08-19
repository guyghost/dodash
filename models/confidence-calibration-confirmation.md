# Modèle de confirmation cross-actifs de la calibration

Cette étude confirme ou réfute la stabilité externe du profil `POWER_THIRD`
sélectionné par `confidence-calibration.md`. Elle ne sélectionne aucun nouveau
profil et ne modifie aucun seuil après chargement des données.

## Question et protocole figé

La question est : « `POWER_THIRD` conserve-t-il une échelle d'exposition
mesurable et sûre sur des actifs absents des études locales antérieures ? »

Le protocole est déclaré avant toute lecture de bougies :

- produits : `ALGO-USD` et `FIL-USD` ;
- folds : `2022-08-19/2023-08-19`, `2023-08-19/2024-08-19`,
  `2024-08-19/2025-08-19` et `2025-08-19/2026-08-19` ;
- profils exécutés : `IDENTITY` comme contrôle et `POWER_THIRD` comme unique
  profil à confirmer ;
- stratégies calibrées : `ema-cross` et `breakout` ;
- référence inchangée : `rsi-reversion` ;
- décisions `ONE_DAY`, exécution `SIX_HOUR`, marché `SPOT_LONG_ONLY` ;
- capital initial 10 000 USD, cible 1 000 USD, frais 6 bps, slippage 2 bps,
  stop fixe 150 bps, objectif fixe 300 bps et limites de risque identiques.

Le recensement local précédant la déclaration ne trouve aucun artefact d'étude
ALGO ou FIL. Cette absence locale justifie le choix cross-actifs mais ne prouve
pas que ces marchés n'ont jamais été observés hors du dépôt.

## États, événements et transitions

Le runner one-shot suit les états explicites suivants :

1. `CREATED` reçoit `PROTOCOL_DECLARED` et devient `FROZEN` ;
2. `FROZEN` reçoit `DATASET_LOAD_STARTED` et devient `COLLECTING` ;
3. `COLLECTING` accepte `RUN_RECORDED` uniquement pour une combinaison attendue ;
4. une matrice complète reçoit `EVIDENCE_ASSESSED` et devient `CONFIRMED` ou
   `NOT_CONFIRMED` selon le cœur pur ;
5. un échec de chargement, une combinaison absente/dupliquée ou un invariant
   violé reçoit `EVIDENCE_REJECTED` et devient `INVALID_EVIDENCE` ;
6. `CONFIRMED` ou `NOT_CONFIRMED` reçoit `ARTIFACT_WRITTEN` et devient
   `COMPLETED` avec le statut global `RESEARCH_ONLY`.

`INVALID_EVIDENCE` est terminal et n'écrit pas de nouvel artefact final. Il
n'existe ni remplacement de produit, ni changement de fold, ni retry
décisionnel, ni fallback vers un autre profil.

## Grain et validité de l'évidence

Le grain d'une observation est
`profil × produit/fold × stratégie calibrée`. La matrice attend donc exactement
32 observations : deux profils, huit run keys et deux stratégies.

Chaque observation contient le nombre d'évaluations, de signaux actifs, BUY et
SELL, la médiane et le p95 du notionnel demandé, les taux de plafonnement et de
rejet risque, le drawdown, le turnover et les frais rapportés au capital.

Pour chaque run key, une preuve séparée confirme que le benchmark et le scénario
RSI sont strictement identiques entre `IDENTITY` et `POWER_THIRD`. Pour chaque
stratégie calibrée, les deux profils doivent avoir les mêmes nombres
d'évaluations, de signaux actifs, BUY et SELL. Toute différence invalide
l'évidence au lieu de produire un verdict négatif.

Les nombres doivent être finis et dans leur domaine. Une observation active
nulle exige des distributions absentes ; une observation active exige une
médiane et un p95 strictement positifs avec `p95 >= médiane`.

## Politique de confirmation

Seules les 16 observations `POWER_THIRD` participent au verdict. Le PnL, le
rendement, le Sharpe, le win rate et le profit factor sont absents du cœur de
décision.

Le profil est `CONFIRMED` si et seulement si :

1. chaque run/stratégie contient au moins un signal actif ;
2. pour EMA et breakout, la médiane non pondérée des huit notionnels médians
   appartient à `[100, 400]` USD ;
3. pour chaque stratégie, au moins six des huit notionnels médians de run
   appartiennent à `[100, 400]` USD, soit une couverture minimale de `75%` ;
4. aucun signal n'est plafonné par l'allocation ou rejeté par le risque ;
5. le drawdown maximal ne dépasse pas `10%` ;
6. le turnover maximal ne dépasse pas `10` fois le capital initial ;
7. les frais maximaux ne dépassent pas `1%` du capital initial.

Une preuve valide qui échoue au moins une règle produit `NOT_CONFIRMED` avec une
liste fermée de motifs. Elle ne déclenche aucune recherche de paramètres.

## Effets de bord

Le cœur de confirmation est synchrone et pur. Le shell est seul autorisé à :

- charger les bougies Coinbase ;
- exécuter les suites papier ;
- horodater et journaliser la progression ;
- écrire l'artefact JSON de manière atomique après un verdict valide.

Le shell appelle le modèle ; le modèle ne connaît ni réseau, ni fichiers, ni
horloge. Aucun LLM ne produit ou ne change un état.

## Invariants

1. `POWER_THIRD` et tous les seuils sont figés avant le premier chargement.
2. La baseline est descriptive et ne peut remplacer le profil figé.
3. Le nombre et la direction des signaux restent identiques entre profils.
4. RSI et le benchmark restent strictement identiques entre profils.
5. Chaque produit/fold a le même poids dans les agrégats.
6. Une matrice invalide ne peut produire ni `CONFIRMED` ni `NOT_CONFIRMED`.
7. Un verdict ne peut activer le trading live ou modifier une configuration live.
8. L'artefact conserve les hashes, comptes de bougies, paramètres et résultats
   nécessaires à la reproduction.
