# Modèle des effets Cloudflare

Les adapters de `apps/` traduisent le monde extérieur en événements de la machine. Ils ne choisissent jamais une transition.

## MCP marché

Entrée fermée : produit, timeframe, limite. Sortie : chandelles ou ticker validés par `@dodash/domain`.

- La réponse Coinbase est bornée (`limit ≤ 350`) avant lecture JSON.
- Le cache utilise une clé déterministe et un TTL inférieur à la granularité.
- Toute réponse non conforme devient `INVALID_RESPONSE`.
- `429` devient `RATE_LIMITED`, les pannes réseau `NETWORK_UNAVAILABLE`.

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

