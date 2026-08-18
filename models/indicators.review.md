# Revue du moteur d’indicateurs

| Cas | Résultat attendu | Couvert par le modèle |
| --- | --- | --- |
| Série nominale | snapshot complet | Oui |
| Série vide/invalide | erreur de domaine | Oui |
| Historique trop court | `INSUFFICIENT_CANDLES` | Oui |
| Paramètre nul ou non entier | `INVALID_CONFIG` | Oui |
| EMA rapide ≥ EMA lente | `INVALID_CONFIG` | Oui |
| Parse Prolog impossible | `PROLOG_PARSE_ERROR` | Oui |
| Query sans solution | `PROLOG_QUERY_FAILED` | Oui |
| Limite du moteur atteinte | `PROLOG_LIMIT_EXCEEDED` | Oui |
| Valeur non numérique | `NON_NUMERIC_RESULT` | Oui |

Le moteur ne gère ni permission, ni annulation, ni retry : ces décisions appartiennent à la machine XState. Les calculs n’émettent qu’un résultat typé consommé par `INDICATORS_COMPUTED` ou `INDICATORS_FAILED`.

