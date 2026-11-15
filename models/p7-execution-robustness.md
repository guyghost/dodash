# P7 — robustesse aux coûts et au prix d'exécution

Statut : **NORMATIF, approuvé par l'opérateur avant implémentation et premier run**
(2026-10-13). Les scénarios et verdicts sont désormais figés.
Recherche historique, paper only ; aucun appel réseau, déploiement, ordre,
changement de configuration ou modification de `target-exposure`.

## Objectif et portée

Tester la sensibilité du candidat runtime P7 à des hypothèses moins idéalisées.
Réutiliser `planTargetExposure`, `targetExposureRiskGate`, `checkRisk` et
`executePaperOrder`, sans recopier la stratégie. Deux créneaux indépendants
de 10 000 $, BTC/ETH ; poche ETH en cash avant sa cotation, comme le test de
cohérence runtime. Aucun transfert entre créneaux.

Historique déjà consulté : les deux jobs de la campagne daily-long du 9 octobre,
avec leurs SHA-256 de fichiers vérifiés avant parsing. Tuples archivés
`[start, open, close]` ; pas de minute, spread, high/low ni carnet disponible.
Tous les jours/produits sont conservés ; aucun **nouveau** remplissage de trou.
Amendement de provenance approuvé avant tout résultat économique : l'archive
ETH contient déjà **2 bougies comblées** (sur 3 787), BTC **0** (sur 4 090).
Ces comptes exacts sont vérifiés et publiés ; les tuples archivés ne portent
pas le flag individuel, donc leurs dates ne sont pas prétendues identifiées.
Les opens de ces deux lignes peuvent être synthétiques : limite explicite de
tous les scénarios ETH, sans retrait de jour ni reconstruction supplémentaire.
**Ce n'est pas de l'OOS et aucun verdict n'autorise le live.**

## Scénarios figés

| ID | Prix d'exécution | Frais bps | Slippage adverse bps |
|---|---|---:|---:|
| C0 | close de décision (référence idéalisée) | 60 | 2 |
| O0 | open du jour immédiatement suivant | 60 | 2 |
| O1 | même open | 60 | 10 |
| O2 | même open | 60 | 50 |
| O3 | même open | 120 | 10 |
| O4 | même open | 120 | 50 |

Les opens sont un proxy à la frontière de disponibilité, pas un prix garanti
à 00:01 ni une simulation fidèle de deux heures de latence. Le signal ne
consulte jamais l'open suivant. Les stress de slippage sont conventionnels,
pas des mesures de spread/latence ; leur coût n'est ajouté qu'une fois.
On ne prétend pas que l'open suivant est systématiquement défavorable.

## Contrat du replay

1. Vérifier empreintes, grille daily UTC, unicité, continuité, nombres finis
   positifs et période. Échec => pas de résultats économiques ni archive
   présentée comme valide. Les comptes de remplissage hérités doivent être
   exactement BTC=0/ETH=2 ; autre provenance => échec. Autoriser uniquement la période pré-cotation ETH
   absente ; ensuite alignement complet avec BTC requis.
2. Pour O0–O4, exécuter l'intention du close précédent à l'open courant,
   **avant** la décision du close courant. Pour C0, exécuter immédiatement au
   close courant. Chaque intention est exécutée au plus une fois.
3. La décision P7 ne voit que la fenêtre close de 240 bougies jusqu'au jour
   courant et le cash/position effectivement présents. SMA, vol cible,
   ancres, dérive, minimum d'ordre et portes de risque restent ceux du modèle.
4. Les frais/slippage du scénario sont connus au sizing via les arguments
   déjà prévus par `planTargetExposure` ; ce n'est pas une recherche de règle
   d'allocation. Le changement de prix close→open peut rendre un achat trop
   cher : garder sa quantité, compter `INSUFFICIENT_CASH`, ne pas adapter
   rétroactivement, remplir partiellement ou rejouer l'ordre.
5. Gardes de risque du paper P7 identiques au test de cohérence : perte
   `min(0, decisionCandlePnl(window, q))` pour achat, perte neutralisée pour
   réduction. Cela reproduit la convention de risque du modèle ; ce n'est
   pas une réconciliation intrajournalière réelle. Refus conservés et comptés.
6. Quantité/cash non négatifs ; pas de levier ni position à découvert.
   Toute autre erreur inattendue invalide le run, sans masquer le jour.
7. Pas d'open après le dernier jour archivé : compter l'intention finale
   non exécutée ; conserver la position et valoriser au dernier close.
   Pas de liquidation terminale inventée. Les frais de sortie future ne sont
   donc pas inclus ; ils restent une limite explicite.

## Mesures et verdicts figés

Même calendrier et 5 fenêtres que `allocation-policies-campaign.md`. Equité
consolidée daily au close, avec capital initial inclus avant les frais ;
positions/cash portés entre fenêtres, pas de réinitialisation des créneaux.

Rapporter : capital final, rendement net, CAGR, max drawdown global et par
fenêtre, frais réellement imputés, coût de slippage des fills, ordres remplis,
achats bloqués par risque, refus broker et intention finale non exécutée.
Différences de CAGR/drawdown vs C0 ; pas de classement optimisé des stress.

- C0 doit reproduire le test de cohérence existant dans ses tolérances figées
  (CAGR 52 % ±8 points ; DD 45,6 % ±6 points ; global/fenêtres ≤50 %).
  Sinon `REFERENCE_MISMATCH` : ne pas interpréter les stress.
- Scénario `WITHIN_CONSTRAINT` si rendement net strictement positif et DD
  global **et chaque fenêtre ≤50 %** ; sinon `OUTSIDE_CONSTRAINT`.
- Synthèse `ROBUST_IN_TESTED_SCENARIOS` seulement si les cinq stress passent,
  sinon `SENSITIVE_TO_ASSUMPTIONS`. Ces libellés ne sont jamais VALIDATED/GO.
- Les seuils restent gelés après le premier run, même en cas de verdict négatif.
  Aucun changement de P7, retrait de scénario ou ajout de produits après lecture.

## Workflow XState et effets

`idle → validating → replaying → assessing → completed`, ou `invalid` final.
Événements : `START`, `DATA_READY`, `REPLAY_READY { results }`, `FAILED`.
`DATA_READY` suit la validation des fichiers ; `REPLAY_READY` suit le calcul
des six scénarios. L'assesseur pur dans `models/` décide des verdicts et de
la validité de la référence ; une référence invalide mène à `invalid`.
Le shell ne fait que lire/hacher les fichiers, calculer les trajectoires et
archiver l'issue. Aucun LLM, réseau, état de trading ou effet de déploiement.

## Plan / structure / vérification

Approbation opérateur obtenue avant exécution :

1. Passer ce modèle à normatif, écrire sa revue et commiter le protocole seul.
2. Tests synthétiques avant implémentation : causalité du signal, effet de
   l'open suivant, refus cash sans redimensionnement, frais buy/sell, bilan
   cash/position, warmup/ETH absent, trou/doublon et dernier ordre non exécuté.
3. Core pur et shell fichiers dans `docs/analysis/p7-execution-robustness*.mjs`,
   tests Node `docs/analysis/p7-execution-robustness.test.mjs`. Dépendances
   workspace existantes ; aucune dépendance externe supplémentaire.
4. Tests passent avant replay réel. Exécution hors réseau ; dossier de preuves
   nouveau, sans écraser une capture existante ; SHA de script/modèle/datasets.
5. Rapport avec les six scénarios, coûts, refus et limites ; ne pas extrapoler
   le CAGR à l'avenir. Les modèles de lancement live restent inchangés.

Commandes prévues :

```sh
pnpm --filter @dodash/backtest build
node --test docs/analysis/p7-execution-robustness.test.mjs
node docs/analysis/p7-execution-robustness-2026-10-13.mjs
pnpm check
pnpm scan:secrets
```

Approbation explicite : six scénarios, conventions d'exécution et verdicts
ci-dessus. Une nouvelle hypothèse exige un nouveau protocole, jamais une
révision silencieuse de celui-ci après observation.
