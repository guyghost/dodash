# Revue — planification des retries marché (2026-09-28)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**.

| Cas | Décision du modèle | Statut |
| --- | --- | --- |
| 429 première tentative | attente 60 s persistée, alarme ponctuelle | Couvert |
| 429 répétés | 300 s puis 900 s, puis `BUDGET` | Couvert |
| `Retry-After` court/long/absent | max(délai, Retry-After) plafonné 900 s | Couvert |
| Échéance de décision dépassée | `DEADLINE` : un seul refetch, cycle clos | Couvert |
| Cycle déjà hors fenêtre au déclenchement | erreur qualifiée non retryable : un appel | Couvert |
| Stop/kill pendant l'attente | `shutdownRequested` prioritaire, aucun fetch | Couvert (garde existante) |
| Réveil horaire pendant l'attente | reprise du cycle si `now ≥ nextRetryAt`, sinon aucun effet | Couvert |
| Alarme orpheline | no-op | Couvert |
| Deux produits | `marketRetry` et alarme par produit ; alarme partagée intacte | Couvert |

Notes : aucune nouvelle transition XState — la machine possède déjà
`retryingMarketData` et son événement ; le modèle fixe la sémantique temporelle
des effets que `agent-runtime.md` exigeait déjà. La qualification `retryable:
false` par l'adapter est une classification de réponse externe, conforme à
`effects.md` (« les adapters traduisent une réponse externe en événement typé »).
Le refetch unique après `exhausted` sur voie stale peut encore répéter jusqu'au
budget par `canRetryStaleMarketData` : accepté, cas rare (bougie jamais décidée
et déjà hors fenêtre), noté comme limite.

## Revue de la documentation PR #20 (2026-09-30)

Le contrat normatif §2 et les appelants utilisent un index de retry 0-based
(`context.attempts.marketData - 1`). Le commentaire TypeScript doit décrire
ce même index ; aucun changement du planificateur ni de ses appelants.
