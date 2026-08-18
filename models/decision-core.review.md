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

