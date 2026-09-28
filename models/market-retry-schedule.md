# Planification des retries marché — délais persistants et échéance de décision

Statut : normatif (2026-09-28). Complète `agent-runtime.md` (« les phases
`retrying*` ne déclenchent aucun effet immédiatement ») et `effects.md`.

## 1. Constat

L'interpréteur envoyait `RETRY_TIMER_ELAPSED` immédiatement dans toute phase
`retrying*` : trois refetch en moins d'une seconde contre un limiteur de débit.
Preuve : cycles récupérés après 429 en 928 ms de moyenne, échecs terminaux en
761 ms ; une décision daily perdue (ETH-USD 27-09) après sept cycles horaires
`RATE_LIMITED`.

## 2. Planificateur pur

```ts
planMarketRetry({
  attempt,               // index 0-based du retry planifié = context.attempts.marketData − 1
  retryLimit,            // context.retryLimits.marketData
  retryable,             // error.retryable
  retryAfterMs,          // WorkflowError.retryAfterMs ?? null
  now,                   // horloge injectée
  triggeredAt,           // T du cycle
  timeframeMs,           // D
  maxMarketStalenessMs,  // S
}) →
  | { kind: "schedule"; nextRetryAt; deadlineAt; attempt: attempt + 1 }
  | { kind: "exhausted"; reason: "NOT_RETRYABLE" | "BUDGET" | "DEADLINE"; deadlineAt }
```

Règles figées :

- `decisionCandleClosedAt = floor(T / D) × D` ; `deadlineAt = decisionCandleClosedAt + S`.
- Délais par tentative (1-indexés) : `MARKET_RETRY_DELAYS_MS = [60 000, 300 000, 900 000]` ;
  au-delà de la table, la dernière valeur. `Retry-After` remplace le délai s'il
  est plus long ; plafond `MARKET_RETRY_MAX_DELAY_MS = 900 000`.
- Ordre d'évaluation : `NOT_RETRYABLE` si `retryable === false` ; `BUDGET` si
  `attempt ≥ retryLimit` ; `DEADLINE` si `now + délai > deadlineAt` ; sinon
  `schedule` avec `nextRetryAt = now + délai` et `attempt + 1` (retries consommés,
  valeur persistée dans `artifacts.marketRetry.attempt`, égale à
  `context.attempts.marketData`).
- La fonction est pure et déterministe ; elle ne lit aucune horloge globale.

## 3. Effets (interpréteur et Durable Object)

En `retryingMarketData` :

1. Si `artifacts.marketRetry` est absent ou si `marketRetry.attempt !==
   context.attempts.marketData` : appeler `planMarketRetry`.
   - `schedule` : checkpoint de `artifacts.marketRetry = { attempt, nextRetryAt,
     deadlineAt, errorCode }` **avant** l'effet `scheduleRetry(nextRetryAt)`,
     puis retour sans événement (le cycle reste en `retryingMarketData`).
   - `exhausted` : envoyer `RETRY_TIMER_ELAPSED` immédiatement (le refetch
     unique qui suit ferme le cycle par la voie existante : `FAILED` ou
     `NO_ACTION` stale).
2. Sinon, si `now ≥ marketRetry.nextRetryAt` : envoyer `RETRY_TIMER_ELAPSED`.
3. Sinon : retour sans événement.

Avant la première tentative, l'effet marché qualifie `retryable: false` toute
erreur retryable dont le premier retry ne pourrait aboutir avant `deadlineAt`
(classification de l'adapter, pas décision) : le cycle échoue en un appel.

L'alarme `retryTick` est une alarme ponctuelle du DO (`schedule(Date)`), avec
`productId` en charge utile, idempotente par cycle. Elle reprend le cycle avec
`triggerAlarm = false`. Une alarme orpheline (cycle déjà clos) est un no-op.
L'alarme partagée du portefeuille n'est jamais annulée ni déplacée (INV-P3).

## 4. Invariants

1. Pas de boucle active ni d'attente longue en mémoire : chaque tentative est un
   réveil distinct.
2. Aucune tentative avant `nextRetryAt`, aucune programmée après `deadlineAt`.
3. Stop/kill gardent leur priorité : `shutdownRequested` est évalué avant tout
   `RETRY_TIMER_ELAPSED`.
4. Un retry ne produit jamais un ordre pour une bougie déjà décidée ni pour une
   bougie hors fenêtre de fraîcheur : les gardes existantes de la machine
   restent seules juges.
5. Le budget (`retryLimits.marketData`) n'augmente pas.
6. Aucune rotation d'adresse, aucune clé, aucun contournement fournisseur.

## 5. Vérification requise

- Horloge injectée : 429 → planification 60 s ; 429 répété → 300 s puis 900 s ;
  `Retry-After` 1 200 s → plafonné 900 s ; `Retry-After` dépassant l'échéance →
  `DEADLINE` ; budget épuisé → `BUDGET` ; erreur non retryable → `NOT_RETRYABLE`.
- Interpréteur : `retryingMarketData` sans échéance atteinte ne fetch pas ;
  reprise après `nextRetryAt` fetch une fois ; stop pendant l'attente →
  `cancelling` sans fetch.
- Deux produits en retry : échéances indépendantes, alarme partagée intacte.
