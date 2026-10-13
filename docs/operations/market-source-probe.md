# Diagnostic Cloudflare des sources de marché

Worker isolé `dodash-market-source-probe-20261013` ; aucun binding au bot,
aucune clé exchange et aucun ordre. Modèle : `models/market-source-probe.md`.

## Déploiement borné autorisé

Depuis `apps/market-source-probe` :

1. `pnpm build`, `pnpm check`, `pnpm test` ; vérifier le modèle et sa revue.
   `pnpm test:runtime` vérifie également le bundle sous workerd, sans appels
   réseau réels grâce à un amont remplacé.
2. `pnpm exec wrangler deploy` : configuration inactive par défaut.
3. Générer un token aléatoire distinct (32–256 caractères), puis le transmettre
   via stdin à `pnpm exec wrangler secret put DIAGNOSTIC_TOKEN`. Ne pas le
   mettre dans les arguments, les captures, les fichiers ou les journaux.
4. Déployer avec `--var PROBE_ENABLED:true --var PROBE_STARTED_AT:<epoch-ms>
   --var PROBE_EXPIRES_AT:<epoch-ms>`, fenêtre ≤ 24 h. Archiver les dates et
   les IDs de versions, jamais le token. L'autorisation du 13 octobre porte
   sur une fenêtre de diagnostic, pas sur sa prolongation automatique.
5. Vérifier `GET /health` et le refus 401 d'un `POST /probe` sans token.
   Exécuter une seule sonde avec `Authorization: Bearer <token>`, sans corps
   ni query. Conserver le JSON et son SHA-256.

Le token de la première capture est éphémère et non archivé. Pour une autre
capture manuelle, le remplacer via stdin ; ne pas chercher un token du bot.
Le cron autonome `11 * * * *` ne nécessite pas ce token.

## Capture des crons et interprétation

`pnpm exec wrangler tail --format json` permet une capture bornée. Conserver
uniquement les messages `market_source_probe.completed`, pas les métadonnées
de requêtes HTTP (qui pourraient contenir des informations sensibles).
Les logs stockés peuvent aussi être consultés dans Workers Observability.
Un cron installé n'est pas une preuve d'exécution : vérifier chaque runId.
Les modifications des Cron Triggers peuvent mettre jusqu'à 15 minutes à
se propager ; un tail vide pendant ce délai n'est pas une preuve de panne.

- `OK` signifie parsing valide ; pour les bougies, vérifier aussi `ready`.
- `HTTP_ERROR` n'est pas une panne de données tant que la validité des
  paramètres de requête n'est pas établie (notamment les limites dYdX).
- `SKIPPED_RATE_LIMIT` n'est pas un HTTP 429 supplémentaire.
- `latestStart + 86400000` est la clôture amont ; `completedAt` est le fetch.
- Comparaison de closes à start égal uniquement ; spot/perp non substituables.
- Les appels sont séquentiels, sans retry ; 15 maximum par lot. Pas de quota
  durable commun aux invocations : réserver le token à l'opérateur.
- Colo d'entrée et environnement Cloudflare ne prouvent pas que le bot et
  cette sonde utilisent la même IP de sortie. Cron décalé pour limiter
  l'interférence, pas pour contourner un limiteur.
- Une capture réussie ne prouve ni SLA, ni admission dans le bot, ni rentabilité.

## Arrêt / rollback

Depuis `apps/market-source-probe`, `pnpm exec wrangler deploy` sans overrides
redéploie la configuration inactive. Vérifier `active: false` sur `/health` ;
les nouveaux lots ne font plus d'appels amont. Un lot déjà commencé peut
finir ses appels bornés. L'expiration arrête aussi les nouveaux appels ; le
Worker, le cron et le secret restent installés. Leur suppression est une
opération distincte qui nécessite l'autorisation de l'opérateur.

Ne pas déployer l'agent ou le Worker marché paper dans cette procédure.
