# dodash

Bot de trading stateful pour Cloudflare Agents, structuré en monorepo pnpm/Turborepo avec un cœur fonctionnel pur et une coquille impérative pour les effets.

## Principes

- Les workflows et décisions d’état vivent dans `models/`.
- Les packages de `packages/` sont purs, déterministes et sans I/O.
- Les applications de `apps/` portent les effets Cloudflare, MCP, Coinbase et dashboard.
- Le backtest rejoue le même cœur métier que le live.

## Commandes

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

