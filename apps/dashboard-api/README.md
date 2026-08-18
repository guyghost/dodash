# Dashboard API

Worker Cloudflare stateless qui expose au dashboard une allowlist des commandes
de l'Agent. Le Bearer fourni par l'opérateur est comparé à
`DASHBOARD_ACCESS_TOKEN`, supprimé, puis remplacé par le secret interne
`CONTROL_API_TOKEN` avant l'appel au service binding `dodash-agent`.

Le Worker ne transmet aucun autre header navigateur, refuse le cross-origin,
borne les requêtes à 16 KiB et les réponses à 1 MiB, et ne réessaie aucune
commande mutante. Le contrat est défini dans `models/dashboard-session.md`.

## Configuration

Créer `apps/dashboard-api/.dev.vars` à partir de l'exemple, avec deux valeurs
aléatoires d'au moins 32 caractères. `CONTROL_API_TOKEN` doit être identique à
celui du Worker Agent.

En production, enregistrer les deux valeurs avec `wrangler secret put`. Le
Worker public `dodash-dashboard` transmet `/api/*` à ce Worker par service
binding et sert les assets sur le même hostname. Ce Worker conserve
`workers_dev: false` et n'est jamais exposé directement.

```sh
pnpm --filter @dodash/dashboard-api check
pnpm --filter @dodash/dashboard-api test
pnpm --filter @dodash/dashboard-api dev
```
