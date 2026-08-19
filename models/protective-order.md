# Modèle de l’ordre protecteur

Un ordre protecteur est un acteur éphémère attaché à une position Spot longue.
Il ne choisit jamais d’ouvrir une position. Il transforme une politique figée,
le prix de revient courant et des bougies OHLC validées en un signal déterministe
de clôture totale.

## Politiques

- `NONE` : aucun acteur protecteur n’est créé.
- `FIXED_BPS` : le stop et l’objectif sont placés à des distances fixes du prix
  de revient, exprimées en points de base.
- `ATR_MULTIPLE` : les distances sont `ATR × multiplicateur`, avec l’ATR connu
  à la clôture ayant produit l’ordre d’entrée. L’ATR n’est jamais lu sur la
  bougie d’exécution encore ouverte.

Une politique active doit produire `0 < stopPrice < averageEntryPrice <
takeProfitPrice`. Une politique ou un plan invalide produit un code d’erreur
fermé et aucun ordre.

## États et événements

```text
idle
  └─ ARM_REQUESTED ─→ armed.awaitingOpen

armed.awaitingOpen
  ├─ CANDLE_OPENED sans gap ─→ armed.awaitingRange
  ├─ CANDLE_OPENED avec gap ─→ triggered
  ├─ POSITION_INCREASED ─→ armed.awaitingOpen
  ├─ POSITION_REDUCED ─→ armed.awaitingOpen
  └─ CANCEL_REQUESTED ─→ cancelled

armed.awaitingRange
  ├─ POSITION_INCREASED ─→ armed.awaitingRange
  ├─ POSITION_REDUCED ─→ armed.awaitingRange
  ├─ CANDLE_RANGE_REPLAYED sans touche ─→ armed.awaitingOpen
  ├─ CANDLE_RANGE_REPLAYED avec touche ─→ triggered
  └─ CANCEL_REQUESTED ─→ cancelled
```

`triggered`, `cancelled` et `failed` sont terminaux. Un retour ultérieur à une
position longue crée un nouvel acteur.

## Résolution OHLC

À l’ouverture d’une bougie :

1. `open <= stopPrice` déclenche `STOP_LOSS` à l’open (`GAP_OPEN`) ;
2. `open >= takeProfitPrice` déclenche `TAKE_PROFIT` à l’open (`GAP_OPEN`) ;
3. sinon le bracket attend la plage intrabougie.

Sur la plage `high/low` de la même bougie :

1. si stop et objectif sont tous deux touchés, `STOP_LOSS` gagne à `stopPrice`
   (`AMBIGUOUS_STOP_FIRST`) ;
2. si seul le stop est touché, il déclenche à `stopPrice` (`INTRABAR`) ;
3. si seul l’objectif est touché, il déclenche à `takeProfitPrice`
   (`INTRABAR`) ;
4. sinon l’acteur attend l’ouverture suivante.

Le prix résolu est une référence de marché. Le paper broker applique ensuite
les mêmes frais et le même slippage qu’aux autres ordres. Le modèle ne prétend
pas reconstruire un chemin de ticks absent des bougies.

## Ordre des effets dans le replay

Pour chaque bougie :

1. résoudre le gap d’un bracket armé depuis la bougie précédente ;
2. exécuter à l’open les ordres de stratégie décidés à la clôture précédente ;
3. annuler le bracket si la position est plate ;
4. sur un achat ou un ajout, armer/réarmer depuis le prix de revient courant ;
5. sur une réduction partielle, conserver les prix et réduire la quantité ;
6. résoudre la plage high/low ;
7. marquer l’equity à la clôture puis évaluer les stratégies.

Un déclenchement protecteur vend toute la quantité détenue. Un achat de
stratégie déjà planifié peut donc rouvrir une position au même open après un
stop sur gap ; cette nouvelle position reçoit un nouvel acteur et reste exposée
à la plage intrabougie de cette bougie.

## Invariants

1. Le plan protecteur est immuable entre deux événements de position.
2. La quantité armée est strictement positive et ne dépasse jamais la position.
3. Un ajout recalcule stop et objectif ; une réduction ne déplace aucun seuil.
4. Une bougie est traitée exactement une fois, ouverture avant plage.
5. Les timestamps sont monotones et une bougie ne précède jamais l’armement.
6. Un seul déclenchement terminal est possible par acteur.
7. Aucune décision ne dépend d’une valeur future ou d’un LLM.
8. Le mode `NONE` reproduit bit pour bit le replay antérieur.
9. Les positions Spot, le cash et les quantités protectrices restent positifs ou
   nuls.
10. Le rapport expose le nombre et la nature des sorties protectrices ; leur
    présence ne peut jamais activer le live.
