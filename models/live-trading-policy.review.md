# Revue de la politique live

| Cas | Comportement fermé | Couverture attendue |
| --- | --- | --- |
| produit non confirmé | admission refusée | test du cœur pur |
| nom d'Agent non canonique | admission refusée | test du cœur pur |
| mode, timeframe ou stratégies différents | admission refusée | test du cœur pur |
| capital ou limite différents | admission refusée | test du cœur pur |
| sizing absent ou différent | admission refusée | test du cœur pur |
| flag live absent | démarrage refusé, machine inchangée | test Agent existant |
| credentials absents | démarrage refusé, machine inchangée | test Agent existant |
| même bougie après cycle nominal | `NO_ACTION`, aucun signal/ordre | test machine + interpréteur |
| même bougie après échec | `NO_ACTION`, aucun nouvel effet d'ordre | test machine |
| bougie plus ancienne | `NO_ACTION` | test machine |
| nouvelle bougie fraîche | calcul nominal | test machine |
| nouvelle bougie périmée | retry borné puis `NO_ACTION`, sans indicateurs, et replanification | test machine |
| reset/restart | dernière clôture et référence journalière conservées | test état/Agent |
| changement de jour UTC | PnL remis à zéro depuis l'equity marquée | test cœur pur |
| kill switch | annulation/réconciliation puis `halted` | test machine existant |
| issue d'ordre ambiguë | réconciliation idempotente | test Agent existant |
| position Coinbase externe | non agrégée, limitation explicite | documentation opérateur |
| stop/take | non attaché, limitation explicite | documentation opérateur |

## Avis de revue

La politique ferme l'admission sur une matrice exacte et laisse les secrets au
shell. Elle ne réinterprète pas le verdict de recherche : l'opérateur a fourni
une autorisation distincte et explicite. La déduplication appartient à la
machine existante, pas au texte d'un prompt. Les erreurs, retries, permissions,
annulations et états terminaux restent ceux de `tradingCycleMachine`.

Deux limitations demeurent intentionnelles et observables : aucune agrégation
du compte Coinbase hors Agent, et aucun ordre protecteur live attaché. Le
rollout doit donc commencer par un seul produit, conserver le kill switch
accessible et vérifier l'issue du premier cycle avant les trois autres.
