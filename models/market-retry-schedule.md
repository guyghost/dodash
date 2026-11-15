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
  `attempt ≥ retryLimit` ; `DEADLINE` si `alignRetryInstant(now + délai) >
  deadlineAt` ; sinon `schedule` avec `nextRetryAt = alignRetryInstant(now +
  délai)` et `attempt + 1` (retries consommés, valeur persistée dans
  `artifacts.marketRetry.attempt`, égale à `context.attempts.marketData`).
- `alignRetryInstant(t) = ceil(t / 1 000) × 1 000` (amendement 2026-10-07) :
  l'alarme ponctuelle du DO a une granularité d'une seconde entière et se
  déclenche dès `floor(maintenant / 1 000) ≥ floor(échéance / 1 000)`. Une
  échéance non alignée laissait l'alarme partir jusqu'à 999 ms **avant**
  `nextRetryAt` ; l'interpréteur (règle 3 ci-dessous) sortait sans effet et la
  chaîne de retries s'arrêtait (preuve : `docs/analysis/analyse-paper-session-2026-10-07.md`,
  31 alarmes de retry sans fetch, couverture daily 3/18). Aligner vers le haut
  garantit que l'alarme ne précède jamais l'échéance persistée.
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

L'alarme `retryTick` est une alarme ponctuelle du DO (`schedule(Date)`). Sa
charge utile est `{ productId, attempt, nextRetryAt, rearm }` ; le SDK
déduplique les alarmes idempotentes sur `callback + payload`, la clé de
déduplication est donc ce quadruplet. Elle reprend le cycle avec
`triggerAlarm = false`. Une alarme orpheline (cycle déjà clos) est un no-op.
L'alarme partagée du portefeuille n'est jamais annulée ni déplacée.

Réveil d'une alarme `retryTick` (amendement 2026-10-07), résolution pure
`resolveRetryWake({ now, persistedNextRetryAt, payload })`. L'échéance de
référence est **celle persistée** dans `artifacts.marketRetry.nextRetryAt` du
cycle en cours du produit ciblé (nulle si aucun retry n'est en attente), jamais
celle de la charge utile : une alarme legacy `{ productId, attempt }` déjà en
vol au déploiement, ou une alarme d'une tentative dépassée, est ainsi jugée
contre l'état réel.

- `rearm` si `persistedNextRetryAt` est défini et `now < persistedNextRetryAt` :
  l'échéance alignée `alignRetryInstant(persistedNextRetryAt)` est
  re-programmée avec `rearm + 1`, sans exécuter de cycle (une échéance legacy
  non alignée ne peut ainsi pas repartir en avance).
  La charge utile doit différer de celle de l'alarme en cours : la ligne en
  cours d'exécution existe encore pendant le callback, puis est supprimée.
  Borne : `MARKET_RETRY_MAX_REARMS = 3` ; au-delà, `drop`.
- `run` sinon, **uniquement pour `payload.productId`** (portefeuille) ou pour
  l'instance mono-produit si `productId` est nul (ou charge utile absente).
  Sur un portefeuille, une alarme sans `productId` (reliquat mono-produit)
  n'exécute aucun produit.
  L'exécution d'un seul produit passe par le même chemin que le réveil de
  portefeuille (`runProductCycle`) : la projection portefeuille (statuts,
  événements terminaux, Σ `dailyPnl`) est mise à jour exactement comme
  aujourd'hui. Les autres produits ne sont jamais exécutés par l'alarme d'un
  produit : un retry n'avance pas un cycle étranger et ne double pas la
  télémétrie.

Limite acceptée : deux produits dont les retries tombent dans la même seconde
sont exécutés séquentiellement dans la même boucle d'alarme ; le décalage de
grille (`cycle-schedule.md` §4) ne s'applique qu'aux réveils de grille, mais il
décale déjà de 2 s l'instant de planification du second produit.

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
7. Une alarme de retry ne se déclenche pas avant l'échéance persistée
   (alignement sur la seconde). Si elle est tout de même réveillée en avance,
   elle se réarme sur la même échéance, au plus `MARKET_RETRY_MAX_REARMS` fois ;
   au-delà, le retry n'est repris qu'au réveil de grille suivant, qui peut
   tomber après `deadlineAt` (le cycle est alors clos par `DEADLINE`).
8. Une alarme de retry n'exécute que le produit qu'elle cible.

## 5. Vérification requise

- Horloge injectée : 429 → planification 60 s ; 429 répété → 300 s puis 900 s ;
  `Retry-After` 1 200 s → plafonné 900 s ; `Retry-After` dépassant l'échéance →
  `DEADLINE` ; budget épuisé → `BUDGET` ; erreur non retryable → `NOT_RETRYABLE`.
- Interpréteur : `retryingMarketData` sans échéance atteinte ne fetch pas ;
  reprise après `nextRetryAt` fetch une fois ; stop pendant l'attente →
  `cancelling` sans fetch.
- Deux produits en retry : échéances indépendantes, alarme partagée intacte.
- Alarme anticipée (amendement 2026-10-07) : avec `now` non aligné, l'instant
  de déclenchement d'une alarme à la seconde (`floor(nextRetryAt / 1 000) ×
  1 000`) n'est jamais antérieur à `nextRetryAt` ; un réveil à cet instant
  refetch ; `DEADLINE` évalué sur l'échéance alignée.
- `resolveRetryWake` : réveil anticipé par rapport à l'échéance persistée →
  `rearm` avec charge utile distincte ; borne `MARKET_RETRY_MAX_REARMS` →
  `drop` ; réveil à l'échéance → `run` du seul produit ciblé ; charge utile
  legacy avant l'échéance persistée → `rearm` ; aucun retry persisté → `run`
  (no-op orphelin dans l'interpréteur).
- La qualification `retryable: false` de l'adapter
  (`qualifyMarketErrorRetryability`) passe par `planMarketRetry` et hérite donc
  de l'alignement : planificateur et adapter ne divergent pas.
