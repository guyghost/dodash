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
LIVE_TRADING_ENABLED=false
```

Lancer le Worker marché sur le port 8788, puis :

```sh
pnpm --filter @dodash/agent dev
```

Le mode paper est le mode par défaut. Les routes `/api/agents/:name/*` et
`/agents/*` refusent toute requête sans Bearer token. Les clients connectés à
l’Agent sont en lecture seule et ne peuvent pas écrire le state.

## Activation du mode live

Le mode live place de vrais ordres. Il reste fermé tant que les cinq variables
serveur suivantes ne sont pas disponibles :

```dotenv
LIVE_TRADING_ENABLED=true
COINBASE_API_BASE_URL=https://api.coinbase.com
COINBASE_API_KEY_ID=organizations/<org>/apiKeys/<key>
COINBASE_PORTFOLIO_ID=<UUID du portfolio Advanced Trade dédié>
COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----
<clé ES256 multiligne exacte>
-----END EC PRIVATE KEY-----"
```

En production, enregistrer `COINBASE_API_KEY_ID`,
`COINBASE_API_PRIVATE_KEY` et `COINBASE_PORTFOLIO_ID` avec
`wrangler secret put`; ne jamais les ajouter à `wrangler.jsonc`. La clé doit
avoir les permissions `view` et `trade`. Chaque requête utilise un JWT ES256
neuf, valable au plus deux minutes. Ni la clé ni le JWT ne sont persistés dans
l’état Agent ou SQLite.

Le couple portfolio/produit est exclusif à DoDash : aucun ordre manuel ni autre
bot ne doit utiliser le même produit dans ce portfolio. Le préflight live doit
échouer si un ordre ouvert n’est pas une protection persistée par l’Agent.

Avec `LIVE_TRADING_ENABLED=false`, exécuter le préflight authentifié avant toute
activation :

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $CONTROL_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"productId":"GRT-USD","executionMode":"live"}' \
  https://<agent-host>/api/agents/grt-usd--multi/preflight
```

Le résultat doit être `ok: true` / `assessment.status: APPROVED`. Le contrôle
est exclusivement en lecture et refuse notamment une clé capable de transfert,
un UUID de portfolio différent ou un ordre ouvert non attribuable à l’Agent.

Une configuration de démarrage peut alors choisir `"executionMode": "live"`.
L'admission live n'accepte que `GRT-USD`, `MANA-USD`, `XTZ-USD` et `ZEC-USD`
avec la politique figée `CONFIDENCE_POWER_THIRD_2026_08` : décision quotidienne,
trois stratégies, notionnel de signal 1 000 USD, ordre et décision plafonnés à
600 USD, capital d’admission 10 000 USD et perte journalière 1 000 USD par Agent.
Une divergence est refusée avant le démarrage de la machine.

Les intentions restent idempotentes grâce à `client_order_id`; un timeout ou
une réponse ambiguë déclenche une réconciliation avant toute décision
terminale. Avant chaque décision, l’Agent lit le portfolio Coinbase réel pour
le cash disponible, la position, l’equity totale, l’exposition des autres
actifs et la perte UTC journalière. Les quantités et prix sont alignés sur les
incréments du produit.

Chaque BUY live porte un bracket Coinbase stop/take attaché et réconcilié. Une
vente annule les protections connues, réconcilie la position, exécute la vente
puis arme et confirme un bracket unique sur tout reliquat. Si une protection ne
peut pas être prouvée, la machine de sécurité annule les ordres, aplatit la
position et termine le cycle en échec ; elle ne reprend jamais la planification
normale avec une position non protégée.
