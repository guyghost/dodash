# ANALYSE-PAPER — Mise en route et épreuve du paper trading local

**Date** : 2026-09-04 · **Environnement** : worktree `analysis-paper`, macOS, Node 22.23.1, pnpm 11.23.0, wrangler 4.125.0
**Mode** : paper uniquement, aucun secret exchange réel, aucun déploiement. Timebox ~45 min respectée (~40 min).

## Verdict en une ligne

Le stack paper local **fonctionne de bout en bout** (dashboard-api → agent DO → mcp-market-data → Coinbase read-only), mais le premier démarrage « du premier coup » échoue à cause de **3 pièges non documentés**, tous contournés et listés ci-dessous.

---

## 1. Ce qui tourne / ce qui bloquait (messages d'erreur exacts)

### Ce qui tourne (état final)

| Composant | Port | Statut |
| --- | --- | --- |
| `dodash-mcp-market-data` | 8787 | `/health` → `{"status":"ok","service":"dodash-mcp-market-data"}` |
| `dodash-agent` (DO `TradingAgent`) | 8788 | `/health` → `{"status":"ok","service":"dodash-agent"}` |
| `dodash-dashboard-api` | 8789 | `/health` → `{"status":"ok","service":"dodash-dashboard-api"}` |

Bindings locaux (registre wrangler) : `MARKET_DATA → dodash-mcp-market-data [connected]`, `AGENT_SERVICE → dodash-agent [connected]`, KV `MARKET_CACHE` en mode local, Analytics Engine simulé.

### Blocage n°1 — paquets workspace non buildés (5 min)

`wrangler dev` sur `apps/mcp-market-data` échoue au bundling tant que `pnpm build` n'a pas été exécuté :

```
✘ [ERROR] Build failed with 2 errors:
  ✘ [ERROR] Could not resolve "@dodash/domain"
  The module "./dist/index.js" was not found on the file system:
    node_modules/@dodash/domain/package.json:10:17:
      "default": "./dist/index.js"
```

**Fix** : `pnpm build` à la racine (turbo, cache plein : 62 ms). *Non documenté dans le README (la section « Prérequis » enchaîne `pnpm install` → `pnpm check/test/build`, mais rien n'indique que `build` est un prérequis de `wrangler dev`).*

### Blocage n°2 — token interne non partagé agent ↔ mcp (15 min, la plus insidieuse)

Après `pnpm install` + génération de tokens indépendants dans chaque `.dev.vars`, l'agent démarre, schedule les cycles… et tous échouent en phase `market-data` :

```json
{"outcome":"FAILED","error":{"phase":"market-data","code":"NETWORK_UNAVAILABLE","retryable":false}}
```

Le diagnostic exige la corrélation de deux sources : côté agent, un warning portait la vraie cause —

```
▲ [WARNING] {"event":"market_service_response_failed","status":401}
```

— et le `POST /internal/ticker` direct vers le worker mcp (avec le token du *mcp*) renvoyait `200 OK` avec un prix réel (`{"productId":"BTC-USD","price":81077.34,"source":"coinbase"}`). Conclusion : le binding service local **fonctionnait**, c'est le secret partagé qui ne correspondait pas. Le `.dev.vars.example` de l'agent dit `INTERNAL_SERVICE_TOKEN=replace-with-the-market-worker-internal-token` : un nouvel opérateur qui « génère des tokens locaux » (comme demandé au brief) produit deux tokens distincts et tombe dedans.

**Fix** : copier la valeur `INTERNAL_SERVICE_TOKEN` du `.dev.vars` du mcp dans celui de l'agent, redémarrer les deux workers. *Les 401 internes sont invisibles dans les logs wrangler du mcp (les requêtes via service binding ne passent pas dans `wrangler:info`) — seul le warning agent permet le diagnostic.*

### Blocage n°3 — conflit de port d'inspection multi-worker (5 min)

Au redémarrage simultané des 3 `wrangler dev`, deux workers crashent au lancement :

```
✘ [ERROR] *** Fatal uncaught kj::Exception: kj/async-io-unix.c++:941: failed:
  ::bind(sockfd, &addr.generic, addrlen): Address already in use; toString() = 127.0.0.1:9229
✘ [ERROR] Address already in use (127.0.0.1:9229). Please check that you are not
  already running a server on this address or specify a different port with --port.
```

Le message renvoie vers `--port` alors que le conflit porte sur le port **debugger** (9229 par défaut, partagé par les 3 workers).

**Fix** : `--inspector-port 9229/9230/9231` distincts par worker.

### Notes mineures

- `pnpm install` : le hook `prepare` (simple-git-hooks) échoue dans un worktree (`ENOTDIR: not a directory, mkdir '.../.git/hooks'`) car `.git` est un fichier. Bénin pour cette mission.
- Contexte d'exécution agent : les workers lancés en arrière-plan sont tués entre deux invocations shell ; `nohup … </dev/null … & disown` les fait survivre. Non pertinent hors de ce contexte de test.

---

## 2. Cycles paper exécutés, phases observées, anomalies

### Comptage

- **~5 cycles FAILED** (période blocage n°2) : phase `market-data`, code `NETWORK_UNAVAILABLE`.
- **12+ cycles complets réussis** après correction, au rythme du schedule 10 s, tous :
  - `phase = persisting`, `outcome = NO_ACTION`, `error = null` ;
  - `marketPrice` réel Coinbase (~81 036–81 077 USD) via mcp-market-data ;
  - télémétrie structurée `cycle.completed` dans les logs wrangler :

```json
{"schemaVersion":1,"type":"cycle.completed","timestamp":1788519081201,"agentId":"btc-usd-paper",
 "productId":"BTC-USD","executionMode":"paper","phase":"waiting","outcome":"NO_ACTION",
 "errorCode":null,"latencyMs":285,"dailyPnl":0,"accountEquity":10000,"positionQuantity":0,
 "otherExposureNotional":0,"executionObserved":false,"openOrderCount":null}
```

- Latence cycle observée : 199–674 ms (fetch Coinbase + indicateurs + persistance SQLite).

### Phases machine

`stopped → (POST /start) → waiting → cycle → waiting …` — la machine revient toujours en `waiting` entre deux alarmes ; `enabled: true`, `schedule: {id, intervalSeconds: 10}` persisté.

### Résilience observée (positive)

Les workers ont été redémarrés 2 fois (blocages n°2 et n°3) : le DO a repris **automatiquement** son schedule (alarme persistée) et son historique de cycles (SQLite) ; l'agent a terminé les cycles en cours à la reprise. Un gap d'alarmes pendant l'arrêt des workers n'a laissé aucun état corrompu.

### Anomalies

1. **Code d'erreur trop générique en bout de chaîne** : un 401 d'auth interne est remonté au cycle comme `NETWORK_UNAVAILABLE` (avec `retryable: false`). Le warning `market_service_response_failed` existe, mais un code dédié (ex. `MARKET_AUTH_FAILED`) raccourcirait le diagnostic.
2. **Aucun ordre paper exécuté** (faute de signal stratégie pendant la fenêtre) : `signalCount: 0` partout, donc le tronc *exécution paper* (placement/fill simulé) n'a pas été observé en conditions réelles — seulement l'exécution *live* étant désactivée et le mode paper ne passant par elle, ce n'est pas un défaut, mais une limite de couverture de ce test. `executionObserved: false` et zéro mention d'ordre dans les logs confirment **zéro appel trade**.
3. /cycles a ponctuellement renvoyé une connexion refusée : c'était les workers tués par le shell hôte (artefact de test, pas un défaut produit).

---

## 3. Maturité opérationnelle

| Axe | Évaluation | Détail |
| --- | --- | --- |
| Configuration locale | **Dure, mais réparable** | Les `.dev.vars.example` sont bien faits et le README est précis ; mais 3 pièges non documentés (build workspace, secret interne partagé, conflit inspector-port) coûtent ~35 min sur un premier run. |
| Observabilité | **Bonne** | Logs structurés `cycle.completed` (schemaVersion, outcome, latence, equity), erreurs par phase, `/state` et `/cycles` lisibles. Point noir : sur-diagnostic de `NETWORK_UNAVAILABLE` masquant le 401 interne. |
| Courbe d'entrée nouvel opérateur | **Moyenne** | Après application des 3 fixes documentés ici, démarrage reproductible en ~5 min. Sans eux : première session frustrante, diagnostic 401 non trivial (15 min). |
| Robustesse runtime | **Bonne** | Reprise après redémarrage double, schedule persisté, aucun état corrompu. |
| Sécurité mode paper | **Bonne** | `LIVE_TRADING_ENABLED=false`, `executionMode: paper` par défaut, aucun secret Coinbase/Hyperliquid requis, tokens ≥ 32 chars non commités (`git status` propre). |

## 4. Chemin exact de reproduction (qui marche du premier coup)

```sh
# 0) Prérequis : Node 22, corepack/pnpm 11.23
corepack enable pnpm
pnpm install --frozen-lockfile        # (hook prepare échoue dans un worktree : bénin)
pnpm build                            # REQUIS avant tout wrangler dev (dist/ des paquets workspace)

# 1) .dev.vars — le token interne est PARTAGÉ entre mcp et agent
TOKEN_INTERNAL=$(openssl rand -hex 24)   # 48 chars
TOKEN_CONTROL=$(openssl rand -hex 24)
TOKEN_DASH=$(openssl rand -hex 24)

printf 'INTERNAL_SERVICE_TOKEN=%s\n' "$TOKEN_INTERNAL" > apps/mcp-market-data/.dev.vars

printf 'CONTROL_API_TOKEN=%s\n' "$TOKEN_CONTROL" \
  > apps/agent/.dev.vars.tmp
printf 'INTERNAL_SERVICE_TOKEN=%s\n' "$TOKEN_INTERNAL" >> apps/agent/.dev.vars.tmp   # ← même valeur que le mcp
printf 'LIVE_TRADING_ENABLED=false\nHYPERLIQUID_PERP_TRADING_ENABLED=false\n' >> apps/agent/.dev.vars.tmp
mv apps/agent/.dev.vars.tmp apps/agent/.dev.vars

printf 'DASHBOARD_ACCESS_TOKEN=%s\nCONTROL_API_TOKEN=%s\n' "$TOKEN_DASH" "$TOKEN_CONTROL" \
  > apps/dashboard-api/.dev.vars

# 2) Stack locale — ports HTTP ET ports debugger distincts
cd apps/mcp-market-data && npx wrangler dev --port 8787 --inspector-port 9229 &
cd ../agent           && npx wrangler dev --port 8788 --inspector-port 9230 &
cd ../dashboard-api   && npx wrangler dev --port 8789 --inspector-port 9231 &
# attendre les 3 /health
for p in 8787 8788 8789; do curl -s http://127.0.0.1:$p/health; echo; done

# 3) Instance paper BTC-USD via l'API de contrôle (proxy → DO)
DASH_TOKEN=$(grep '^DASHBOARD_ACCESS_TOKEN=' apps/dashboard-api/.dev.vars | cut -d= -f2)
curl -s -X POST http://127.0.0.1:8789/api/agents/btc-usd-paper/start \
  -H "Authorization: Bearer $DASH_TOKEN" -H "Content-Type: application/json" \
  -d '{"productId":"BTC-USD","intervalSeconds":10,"executionMode":"paper"}'

# 4) Observer (≥ 3 cycles de 10 s)
curl -s "http://127.0.0.1:8789/api/agents/btc-usd-paper/state"    -H "Authorization: Bearer $DASH_TOKEN"
curl -s "http://127.0.0.1:8789/api/agents/btc-usd-paper/cycles?limit=8" -H "Authorization: Bearer $DASH_TOKEN"
#   télémétrie : logs wrangler de apps/agent → lignes "type":"cycle.completed"
```

### Ce qu'il faudrait documenter/corriger dans le repo pour que ça marche « du premier coup »

1. **README** : ajouter `pnpm build` comme prérequis explicite de `wrangler dev` (les workers résolvent `@dodash/*` via `dist/`).
2. **`apps/agent/.dev.vars.example`** : remplacer le commentaire du token par une consigne explicite « copier la valeur `INTERNAL_SERVICE_TOKEN` de `apps/mcp-market-data/.dev.vars` (secret partagé) », ou fournir un script `scripts/dev-vars.sh` qui génère les 3 fichiers cohérents.
3. **README/ops** : documenter l'obligation de `--inspector-port` distincts quand plusieurs `wrangler dev` tournent côte à côte (le message d'erreur renvoie trompeusement vers `--port`).
4. **Code (mineur)** : distinguer dans `market-service.ts` l'échec d'auth (401) de l'échec réseau pour le code d'erreur de cycle (ex. `MARKET_AUTH_FAILED` au lieu de `NETWORK_UNAVAILABLE`).

*Conformité AGENTS.md : aucune modification de code ni de workflow — uniquement des fichiers `.dev.vars` locaux (non commités) et ce rapport. Les recommandations ci-dessus sont à passer en `Model → Review → Implement → Verify` si retenues.*

---

## Addendum (même jour) — les 4 recommandations ont été appliquées

Suivi `Model → Review → Implement → Verify` pour la seule rec touchant le
comportement (n°4) ; recs 1–3 documentaires.

1. **README** ✅ — section « Stack local (wrangler dev) » ajoutée :
   `pnpm build` prérequis + commandes avec `--port`/`--inspector-port`
   distincts et le message d'erreur piégeux cité.
2. **`.dev.vars.example`** ✅ — `apps/agent` : consigne explicite de copier
   `INTERNAL_SERVICE_TOKEN` depuis `apps/mcp-market-data/.dev.vars` (même
   commentaire ajouté sur `CONTROL_API_TOKEN` dans `apps/dashboard-api`,
   piège identique). Pas de script — l'option « commentaire » a été retenue.
3. **README** ✅ — couvert par la même section « Stack local » (recs 1 et 3
   adjacentes dans le même paragraphe).
4. **Code** ✅ — `models/effects.md` étend le mapping MCP marché :
   `401/403` et secret interne trop court → `AUTHENTICATION_FAILURE`
   (non retryable, jamais `NETWORK_UNAVAILABLE`) ; revue à jour dans
   `models/effects.review.md`. Implémentation : helper `responseError()`
   dans `apps/agent/src/market-service.ts` (3 points d'appel).

**Vérification** : `pnpm check` 19/19 ; `pnpm test` 19/19 (dont agent 257
tests, 3 nouveaux/modifiés sur le mapping 401/5xx/secret court) ; épreuve
end-to-end sur le stack local : mauvais token → cycles
`AUTHENTICATION_FAILURE` (avant : `NETWORK_UNAVAILABLE`), token rétabli →
cycles `NO_ACTION` sans erreur.
