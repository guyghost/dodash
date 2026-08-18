# Trading Agent

Worker Cloudflare qui route les commandes authentifiées vers un Durable Object
`TradingAgent` par clé stable `(produit × stratégies)`. Le Durable Object
interprète exclusivement la machine XState de `models/`, conserve un état
synchronisé compact et écrit les artefacts détaillés dans SQLite.

## Configuration locale

Créer `apps/agent/.dev.vars` (ignoré par Git) :

```dotenv
CONTROL_API_TOKEN=<secret aléatoire d'au moins 32 caractères>
INTERNAL_SERVICE_TOKEN=<le même secret interne que mcp-market-data>
```

Lancer le Worker marché sur le port 8788, puis :

```sh
pnpm --filter @dodash/agent dev
```

Le mode paper est le seul mode accepté. Les routes `/api/agents/:name/*` et
`/agents/*` refusent toute requête sans Bearer token. Les clients connectés à
l’Agent sont en lecture seule et ne peuvent pas écrire le state.
