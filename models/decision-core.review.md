# Revue du cœur de décision

| Cas | Stratégies | Allocation | Risque |
| --- | --- | --- | --- |
| Signal nominal | BUY/SELL/HOLD fermé | intention unique | approbation ou code fermé |
| Données insuffisantes | erreur | n/a | n/a |
| Signaux opposés | conservés | compensation déterministe | une seule intention au plus |
| Tous HOLD | conservés | `NO_ACTION` | aucun appel |
| Confiance/taille invalide | erreur de domaine | `FAILED` | n/a |
| Capital insuffisant | n/a | taille plafonnée ou `NO_ACTION` | n/a |
| Cooldown | n/a | intention inchangée | refus |
| Perte journalière | n/a | intention inchangée | refus |
| Exposition/position excessive | n/a | intention inchangée | refus |
| Kill switch | n/a | intention inchangée | refus immédiat |

Annulations, retries, permissions et états terminaux restent dans la machine XState. La chaîne pure est rejouable à l’identique en backtest et ne contient aucune transition d’état implicite.

## Revue des frontières de dépendance

| Frontière | Propriétaire | Consommateurs autorisés |
| --- | --- | --- |
| Calibration et notional cible | `@dodash/strategies` | Agent, backtest |
| Exécution paper déterministe | `@dodash/paper-execution` | Agent, backtest |
| Orchestration de replay et métriques | `@dodash/backtest` | CLI et études de backtest uniquement |

Le graphe attendu est `agent -> stratégies/paper-execution <- backtest`.
Un import de `@dodash/backtest` depuis `apps/agent` est une violation bloquante,
car il transforme un outil de validation en dépendance de production.
