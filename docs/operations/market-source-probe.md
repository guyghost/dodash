# Retrait du diagnostic Cloudflare des sources de marché

Worker `dodash-market-source-probe-20261013`. Modèle :
`models/market-source-probe.md`. Revue du retrait :
`models/market-source-probe.review.md`.

La fenêtre archivée va du 13 octobre 2026 21:04:46.713 UTC au
14 octobre 2026 21:04:46.713 UTC (`1791925486713` → `1792011886713`).
Le code honorait `PROBE_EXPIRES_AT` : après cette échéance, le handler
planifié retournait sans appel amont. Le cron `11 * * * *` restait
installé, et la production gardait `PROBE_ENABLED=true`. Le paquet
`apps/market-source-probe` est retiré du dépôt le 14 novembre 2026.
Rien ne l'importait. Le merge ne supprime pas la ressource Cloudflare.

Ne pas déployer ce Worker, l'agent, ni aucun autre Worker dans cette
procédure. Ne pas lancer `wrangler secret`, `wrangler deploy`, ni un
changement de vars. Ne pas passer `--force` : ce drapeau saute la
confirmation et autorise la suppression même si un autre Worker en
dépend. Live reste inchangé.

## Commande opérateur

Depuis la racine d'un checkout qui contient `@dodash/agent`, avec
Wrangler authentifié sur le compte Cloudflare du sous-domaine
`guyghost.workers.dev`. Wrangler résolu : `4.125.0`. La commande passe
par le paquet agent uniquement pour ce binaire. Le nom positionnel
remplace `name` de n'importe quel `wrangler.jsonc` du répertoire
courant (`getScriptName` fait `args.name ?? config.name`). Sans ce nom,
Wrangler prendrait `dodash-agent`.

```sh
pnpm --filter @dodash/agent exec wrangler delete dodash-market-source-probe-20261013
```

La confirmation doit nommer exactement
`dodash-market-source-probe-20261013`. Si elle nomme `dodash-agent` ou
un autre script, répondre non et s'arrêter. Si Wrangler signale qu'un
autre Worker dépend de celui-ci, s'arrêter aussi : ce n'est pas le cas
attendu, et il ne faut pas ajouter `--force`.

La suppression retire le script, le cron, les vars et le secret
`DIAGNOSTIC_TOKEN`. Ne pas afficher ce secret.

## Vérifier ensuite

1. La sortie contient `Successfully deleted dodash-market-source-probe-20261013`.
2. Le health public ne sert plus le diagnostic :

```sh
curl --silent --show-error --output /tmp/dodash-probe-health.txt --write-out '%{http_code}\n' \
  https://dodash-market-source-probe-20261013.guyghost.workers.dev/health
grep -q '"service":"market-source-probe"' /tmp/dodash-probe-health.txt && echo 'PROBE ENCORE SERVI' || echo 'probe absent'
```

Le second message doit être `probe absent`. Un code HTTP 200 dont le
corps contient `"service":"market-source-probe"` signifie que le Worker
est encore en place.
3. Dans le tableau Cloudflare, le script et son déclencheur
   `11 * * * *` sont absents. Aucun autre Worker n'a changé.
4. Ne pas redéployer depuis un ancien checkout qui contient encore
   `apps/market-source-probe`.

## Historique

Le déploiement borné d'octobre 2026 (config inactive, secret via stdin,
fenêtre ≤ 24 h, une sonde manuelle) est clos. Les captures restent dans
`docs/analysis/evidence-cloudflare-market-source-2026-10-13/`.
Le compte rendu est `docs/analysis/cloudflare-market-source-2026-10-13.md`.
