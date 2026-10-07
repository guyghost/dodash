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

## Revue de l'amendement alarme anticipée (2026-10-07)

Source : `docs/analysis/analyse-paper-session-2026-10-07.md` (31 alarmes de
retry sans fetch, couverture daily 3/18). Revue indépendante du diff de modèle,
verdict initial **CHANGES REQUIRED** (mineur), corrections intégrées :

| Point de revue | Décision |
| --- | --- |
| Alignement vs SDK `agents` 0.21.0 (`floor` à l'écriture, `time <= floor(now)` au réveil) | Correct : pour `at` aligné, réveil ⇔ `now ≥ at` |
| `DEADLINE` évalué sur l'instant aligné | Conserve l'invariant 2 exactement |
| Réveil jugé contre la charge utile | Corrigé : jugé contre `artifacts.marketRetry.nextRetryAt` persisté (alarmes legacy en vol au déploiement, tentatives dépassées) |
| Réarmement d'une échéance legacy non alignée | Réarmé à l'instant aligné, sinon nouveau réveil anticipé |
| INV 7 « jamais perdu » trop fort | Reformulé : borne `MARKET_RETRY_MAX_REARMS`, puis reprise au réveil de grille (éventuellement après `deadlineAt`) |
| « idempotente par cycle » | Reformulé : clé de déduplication `productId, attempt, nextRetryAt, rearm` |
| Classification d'adapter | Déjà via `planMarketRetry` : hérite de l'alignement, aucune divergence |
| Exécution d'un seul produit | Même chemin `runProductCycle` : projection portefeuille inchangée |
| Retries de deux produits dans la même seconde | Limite acceptée, documentée |

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**. Aucune nouvelle transition
XState ; seuls la sémantique temporelle des effets et le routage d'alarme
changent.

Limites hors périmètre, à modéliser séparément : (1) un réveil de grille qui
reprend un cycle encore en `retrying*` le clôt puis rejette sa propre alarme
(`DUPLICATE_ALARM`) : le cycle horaire est perdu ; (2) `isFreshMarketData`
juge l'âge de la bougie contre le `triggeredAt` du cycle repris, pas contre
l'instant du fetch : ETH-USD 30-09 a été décidé à 02:01:01 sur la bougie de
00:00 (au-delà de 2 h réelles).
