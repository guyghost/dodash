# Modèle du backtest

Le backtest possède un workflow autonome :

`idle → loadingHistoricalData → replaying → computingMetrics → completed`

Les échecs de chargement sont les seuls retries automatiques. Le replay et les métriques sont déterministes : une erreur y mène directement à `failed`. Toute phase active accepte `CANCEL_REQUESTED`, puis attend `EFFECT_CANCELLED` avant l’état terminal `cancelled`.

## Manifeste du run

Avant `START_REQUESTED`, l’opérateur fige un manifeste contenant :

- `productId`, `timeframe`, bornes UTC `start` incluse et `end` exclue ;
- source et endpoint historiques, identifiant et empreinte SHA-256 du dataset ;
- stratégies et paramètres d’indicateurs ;
- capital initial, limites d’allocation et de risque ;
- frais et slippage du broker papier ;
- politique protectrice `NONE`, `FIXED_BPS` ou `ATR_MULTIPLE` ;
- politique d’exécution `NEXT_CANDLE_OPEN` et marché `SPOT_LONG_ONLY`.

Le même dataset et les mêmes paramètres non stratégiques sont utilisés pour
chaque stratégie isolée, l’ensemble de stratégies et le benchmark buy-and-hold.
Le rapport final restitue le manifeste et l’empreinte : un résultat sans
provenance n’est pas un backtest valide.

## Effets

1. `loadingHistoricalData` appelle uniquement la frontière de données de marché.
   Les pages Coinbase sont bornées à 350 bougies, fusionnées par timestamp puis
   triées. Les doublons, trous de série, valeurs invalides et bougies hors bornes
   font échouer le chargement.
2. La bougie en cours, dont la clôture n’est pas encore connue à `end`, est
   exclue du dataset.
3. `replaying` est pur. Une décision à la clôture de la bougie `t` ne peut être
   exécutée qu’à l’ouverture de `t+1`. La dernière décision sans bougie suivante
   n’est jamais exécutée.
4. En `SPOT_LONG_ONLY`, un achat ne peut dépasser le cash disponible après
   frais et une vente est plafonnée à la position détenue. Aucun emprunt, short
   synthétique ou levier implicite n’est autorisé.
5. `computingMetrics` calcule les métriques de la stratégie et le benchmark
   buy-and-hold sur exactement les mêmes bornes, frais et capital initial.
   Les frais d’entrée sont intégrés au prix de revient moyen. Seuls les fills
   qui réduisent une position entrent dans le win rate et le profit factor.
   Le rapport sépare PnL réalisé et latent.
6. Aucun état ni effet du backtest ne peut appeler l’adapter d’exécution live.
7. Lorsqu’une politique protectrice est active, chaque position longue crée un
   acteur décrit par `protective-order.md`. Le gap est résolu avant les ordres
   de stratégie de l’open, puis la plage high/low après leur exécution. Le
   rapport compte séparément les sorties stop et objectif.

## Invariants

1. Un run nécessite la permission `canRunBacktest`.
2. Le dataset est identifié et non vide avant le replay.
3. La progression est monotone et bornée par le nombre de chandelles.
4. Le replay réutilise exactement indicateurs, stratégies, allocation et risque du live.
5. `completed`, `cancelled` et `failed` sont terminaux ; un nouveau run utilise un nouvel acteur.
6. Les stratégies ne voient jamais une bougie postérieure à la décision en cours.
7. Le prix de décision et le prix de fill ne proviennent jamais de la même bougie.
8. Le portefeuille Coinbase Spot ne peut avoir ni cash ni quantité négatifs.
9. Tous les scénarios comparés partagent le même dataset et les mêmes coûts.
10. Le rapport expose rendement, PnL, drawdown, Sharpe, nombre de fills,
    rendement buy-and-hold et rendement excédentaire ; aucune métrique isolée ne
    suffit à autoriser le live.
11. À chaque fin de run, `pnl = realizedPnl + unrealizedPnl` à la tolérance
    numérique près ; les frais totaux correspondent à la somme exacte des fills.
12. `NONE` conserve exactement les trades, portefeuilles et métriques historiques.
13. Un trigger protecteur ne peut vendre que la quantité Spot effectivement
    détenue et clôt toujours cette quantité en totalité.
