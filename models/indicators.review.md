# Revue du moteur d’indicateurs

| Cas | Résultat attendu | Couvert par le modèle |
| --- | --- | --- |
| Série nominale | snapshot complet | Oui |
| Série vide/invalide | erreur de domaine | Oui |
| Historique trop court | `INSUFFICIENT_CANDLES` | Oui |
| Paramètre nul ou non entier | `INVALID_CONFIG` | Oui |
| EMA rapide ≥ EMA lente | `INVALID_CONFIG` | Oui |
| Horizons de rendement vides, dupliqués ou non triés | `INVALID_CONFIG` | Oui |
| Seuil de pic de volume nul ou non fini | `INVALID_CONFIG` | Oui |
| Transaction ou niveau de carnet invalide | `INVALID_MICROSTRUCTURE` | Oui |
| Carnet croisé (meilleur bid > meilleur ask) | `INVALID_MICROSTRUCTURE` | Oui |
| Transactions absentes ou vides | `tradeVwap: null` | Oui |
| Carnet absent ou vide | `orderBookVwap: null`, `bidAskSpread: null` | Oui |
| Volume OHLCV nul sur la fenêtre | `ohlcvVwap: null`, `vwapDeviation: null` | Oui |
| Volume de référence RVOL nul | `relativeVolume: null`, `volumeSpike: null` | Oui |
| ATR après la fenêtre initiale | lissage de Wilder, pas SMA glissante | Oui |
| RVOL | référence passée uniquement, volume courant exclu | Oui |
| VWAP transactions et VWAP carnet | sources et sorties distinctes | Oui |
| Force de tendance plate | ADX borné, valeur `0` | Oui |
| Historique supérieur au warmup ADX | fenêtre glissante des `2 × période` dernières chandelles | Oui |
| Parse Prolog impossible | `PROLOG_PARSE_ERROR` | Oui |
| Query sans solution | `PROLOG_QUERY_FAILED` | Oui |
| Limite du moteur atteinte | `PROLOG_LIMIT_EXCEEDED` | Oui |
| Valeur non numérique | `NON_NUMERIC_RESULT` | Oui |

Le moteur ne gère ni permission, ni annulation, ni retry : ces décisions appartiennent à la machine XState. Les calculs n’émettent qu’un résultat typé consommé par `INDICATORS_COMPUTED` ou `INDICATORS_FAILED`.

## Revue de l'amendement du 2026-11-15

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**

- **Pureté et déterminisme** : `trend_strength_di/7`, `rsi_wilder/3` (et sa continuation `rsi_wilder_continue/8`) ainsi que `sma/3` sont des prédicats Prolog purs sans état global, horloge ni I/O.
- **Rétrocompatibilité V1 (INV-M1)** : toutes les nouvelles options (`adxWarmupMultiplier`, `rsiMode`, `longSmaPeriod`) sont facultatives et absentes de `DEFAULT_INDICATOR_CONFIG`, garantissant l’absence de requête Prolog additionnelle et la préservation bit-exacte des snapshots V1 existants.
- **Équivalence incrémentale (INV-M5 / INV-27)** : `rsi_wilder_continue` applique exactement les mêmes opérations flottantes sur le suffixe que le pli complet `rsi_wilder` ; `trend_strength_di` et `longSma` sont évalués dans `evaluateBoundedIndicators` partagé entre `computeIndicators` et `createIndicatorSeriesComputer`.
- **Fail-closed** : les paramètres hors domaine (`adxWarmupMultiplier < 2` ou non entier, `rsiMode` inconnu, `longSmaPeriod <= 0` ou non entier) sont rejetés par `INVALID_CONFIG`.
- **Impact sur les modèles voisins** : aucun changement de signature obligatoire pour les consommateurs existants ; les stratégies comme `TARGET_EXPOSURE` pourront consommer `longSma`, `plusDi`, `minusDi` et `rsiMode: "WILDER"` sans réimplémenter de calcul hors moteur.
