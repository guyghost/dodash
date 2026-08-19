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
