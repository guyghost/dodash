# Modèle du backtest

Le backtest possède un workflow autonome :

`idle → loadingHistoricalData → replaying → computingMetrics → completed`

Les échecs de chargement sont les seuls retries automatiques. Le replay et les métriques sont déterministes : une erreur y mène directement à `failed`. Toute phase active accepte `CANCEL_REQUESTED`, puis attend `EFFECT_CANCELLED` avant l’état terminal `cancelled`.

## Invariants

1. Un run nécessite la permission `canRunBacktest`.
2. Le dataset est identifié et non vide avant le replay.
3. La progression est monotone et bornée par le nombre de chandelles.
4. Le replay réutilise exactement indicateurs, stratégies, allocation et risque du live.
5. `completed`, `cancelled` et `failed` sont terminaux ; un nouveau run utilise un nouvel acteur.

