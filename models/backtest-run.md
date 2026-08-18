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
6. Aucun état ni effet du backtest ne peut appeler l’adapter d’exécution live.

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
