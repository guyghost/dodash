# MCP Market Data

Worker Cloudflare stateless qui expose les outils MCP `get_candles` et
`get_ticker`. Les routes internes utilisent le même adaptateur déterministe pour
l’Agent de trading.

## Configuration locale

1. Remplacer l’identifiant KV factice de `wrangler.jsonc` lors du provisioning.
2. Créer `.dev.vars` (ignoré par Git) avec un `INTERNAL_SERVICE_TOKEN` aléatoire
   d’au moins 32 caractères.
3. Lancer `pnpm --filter @dodash/mcp-market-data dev`.

Le token interne est un secret Wrangler et ne doit jamais être ajouté à
`wrangler.jsonc`. Le serveur MCP public est en lecture seule ; une couche OAuth
devra être ajoutée avant toute exposition sur un domaine public non protégé.
