# Review : diagnostic années faibles

Statut : APPROUVÉ (2 corrections intégrées au modèle avant mesure)

Vérifications contre le code, avant implémentation du script :

| # | Prérequis du modèle | Vérification code | Verdict |
|---|---|---|---|
| R1 | Reconstitution du régime jour par jour | `scripts/regime-days.ts` rejoue `regimeFilterMachine` sur `prepareBacktestIndicators` snapshots ; même flux que replay.ts (send CANDLE_CLOSED puis lecture snapshot) | OK |
| R2 | Séparation exit/directionnel par `clientOrderId` | replay.ts L354 : préfixe `${runId}:protective:` sur les intents protective ; les fills protective passent par `executePaperOrder` → présents dans `trades` | OK |
| R3 | Croisement fills × timeline | `Fill.executedAt` = `candle.start` bougie d'exécution (executePaperOrder L366-372) ; timeline M1 indexée par `candleClosedAt` → dernier régime connu ≤ executedAt défini sans ambiguïté | OK |
| R4 | Stops vs takes | `ProtectiveExitExecution` étend `ProtectiveExitResolution` (kind, triggeredAt) + `fillId` → croisable avec trades | OK |
| R5 | M5 solo + ablation | suite.ts L244-246 : scénarios solo déjà produits par `runBacktestSuite` ; ablation par `createStrategyRegistry` réduit + replay direct (pattern test/regime-sizing-replay.test.ts L68) | OK |
| R6 | Config V1 bit-identique | reprise de `makeConfig` de regime-sizing-walkforward.ts avec C_IDENTITY ; INV-D2 vérifiable contre la grille D2-S publiée | OK |
| R7 | INV-D1 non ambigu | **correction appliquée** : « PnL total » = Σ realizedPnl des trades (metrics.totalReturn inclut l'unrealized — non comparable) | corrigé |
| R8 | M5 opérable sans modifier replay | **correction appliquée** : M5 précisée en (a) solo depuis le rapport suite, (b) ablation par replay direct avec registry réduit | corrigé |

## Points d'attention pour l'implémentation

- L'attribution M2 utilise le régime du **dernier `candleClosedAt` ≤
  `executedAt`** : attention à ne pas utiliser le régime postérieur au
  fill (off-by-one temporel) — test de l'invariant INV-D1 couvre ce
  risque (toute erreur d'aiguillage casse la somme).
- Les ablations M5 doivent réutiliser strictement les mêmes constantes
  de config (y compris `targetSignalNotional`, risque, broker) : seule
  la liste des stratégies du registry change.
- Le seuil de dominance 60 % (§4) est calculé sur la perte nette
  annuelle — implémenté comme spécifié, sans lecture post hoc.

## Verdict

APPROUVÉ — le modèle est mesurable sans modification du moteur de
replay ; les deux corrections (INV-D1, M5) sont intégrées.
