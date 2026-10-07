# Modèle des effets Cloudflare

Les adapters de `apps/` traduisent le monde extérieur en événements de la machine. Ils ne choisissent jamais une transition.

## MCP marché

Entrée fermée : produit, timeframe, limite. Sortie : chandelles ou ticker validés par `@dodash/domain`.

- La réponse Coinbase est bornée (`limit ≤ 350`) avant lecture JSON.
- Le cache utilise une clé déterministe et un TTL inférieur à la granularité.
- Toute réponse non conforme devient `INVALID_RESPONSE`.
- `429` devient `RATE_LIMITED`, les pannes réseau `NETWORK_UNAVAILABLE`
  (retryable uniquement si le statut est ≥ 500).
- Un refus d'authentification du worker marché (`401`/`403`) ainsi qu'un
  secret interne absent ou trop court deviennent `AUTHENTICATION_FAILURE`
  (non retryable) : un secret partagé incorrect n'est jamais une panne
  réseau et n'appelle aucun retry.

### Fenêtre de chandelles d'un cycle

Pour un cycle déclenché à `T` et une granularité `D`, Coinbase traite le
paramètre `end` comme une borne **inclusive** sur le timestamp de début des
chandelles. L'Agent doit donc demander comme borne finale le début de la
dernière chandelle entièrement close :

```text
currentBucketStart = floor(T / D) × D
latestClosedStart = currentBucketStart - D
request.end = latestClosedStart / 1 000
```

États et événements de l'effet :

| État du cycle | Événement / condition | Effet | État suivant décidé par le modèle |
| --- | --- | --- | --- |
| `fetchingMarketData` | alarme à `T` | dérive `latestClosedStart`, appelle le binding marché | reste en attente de résultat |
| `fetchingMarketData` | série valide dont la dernière clôture est `≤ T` | checkpoint puis `MARKET_DATA_READY` | `computingIndicators` ou déduplication |
| `fetchingMarketData` | série vide, mal formée ou hors contrat | `MARKET_DATA_FAILED` | retry borné ou persistance d'échec |
| `fetchingMarketData` | dernière clôture trop ancienne ou future | `MARKET_DATA_READY` avec son instant réel | la garde de fraîcheur décide retry ou `NO_ACTION` |

Invariants :

1. La chandelle qui commence à `currentBucketStart` n'entre jamais dans une
   décision du cycle déclenché à `T`.
2. Une alarme exactement sur une frontière utilise la chandelle qui vient de
   fermer, jamais celle qui vient de s'ouvrir.
3. Le même calcul s'applique à toutes les granularités, y compris `ONE_DAY`.
4. Le cache ne modifie pas la fenêtre : sa clé contient les bornes calculées.
5. L'adapter ne décide aucune transition ; la fraîcheur et la déduplication
   restent des gardes de `tradingCycleMachine`.

## Authentification et exécution Coinbase

1. L’intention et son `clientOrderId` sont persistés.
2. Un JWT ES256 est fabriqué juste avant l’appel, avec `nbf`, `exp ≤ now + 120 s` et nonce cryptographique.
3. Le JWT et la clé privée ne sont jamais écrits en state, SQL ou logs.
4. Un timeout ou une rupture après soumission devient `ORDER_OUTCOME_UNKNOWN` et force la réconciliation par `clientOrderId`.
5. Un rejet HTTP explicite devient `ORDER_REJECTED` ; le retry conserve le même `clientOrderId` et régénère le JWT.

## Persistance

L’Agent conserve un état synchronisé compact. Les cycles, intentions, ordres et erreurs détaillés vivent dans SQLite embarqué. Une transaction logique écrit l’issue avant la reprogrammation.

## Scheduling et contrôle

- `scheduleEvery` est idempotent par instance `(paire × stratégie)`.
- Le kill switch et les permissions passent par des méthodes RPC typées, qui envoient ensuite un événement au modèle.
- Les clients ne modifient jamais directement l’état synchronisé de la machine.

## Amendement 2026-09-28 — cache immuable, `Retry-After`, retryabilité à l'échéance

- **Cache des chandelles closes.** Quand la fenêtre demandée est entièrement
  close (`(end + D) ≤ now`), le snapshot est immuable : TTL
  `CLOSED_WINDOW_CACHE_TTL_SECONDS = 21 600`. La règle « TTL inférieur à la
  granularité » ne s'applique qu'aux fenêtres contenant la chandelle en cours.
  La clé contient toujours les bornes : aucun mélange de fenêtres.
- **`Retry-After`.** Le Worker marché journalise `coinbase_rate_limited`
  (`kind`, `productId`, `retryAfterSeconds`) et renvoie l'en-tête `Retry-After`
  sur ses réponses 429 internes quand Coinbase l'a fourni. L'agent le porte
  dans `WorkflowError.retryAfterMs` (diagnostic optionnel ; aucune garde ne le lit).
- **Journal par requête marché (amendement 2026-10-07).** Chaque lecture
  `getCandles`/`getTicker` du Worker marché émet un log structuré
  `coinbase_market_request` : `kind`, `productId`, `cached` (succès servi par
  le cache), `status` (statut HTTP amont, `null` si cache ou erreur réseau),
  `outcome` (`OK` ou code `MarketDataError`), `retryAfterRaw` (en-tête brut,
  tronqué à 64 caractères, `null` si absent) et `latencyMs`. Diagnostic
  uniquement : aucune garde, aucun cache ni retry ne le lit ; aucune donnée
  sensible (API publique, sans clé).
- **Retryabilité à l'échéance.** L'effet marché qualifie `retryable: false`
  toute erreur retryable dont le premier retry planifié (`market-retry-schedule.md`)
  ne pourrait aboutir avant `deadlineAt` : classification d'adapter, pas décision.
