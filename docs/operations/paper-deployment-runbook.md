# Runbook — Déploiement paper production 24/7 (préfixe isolé)

**Date** : 2026-09-04 · **Proposition** : swarm-dao #42 · **Compte Cloudflare** :
Guyghost@gmail.com's Account (`bab940ffcf652079ec6172c267afa11e`, OAuth).

**Périmètre** : paper only (C1). Aucun secret Coinbase/Hyperliquid n'est créé,
configuré ni déployé. `LIVE_TRADING_ENABLED=false` et
`HYPERLIQUID_PERP_TRADING_ENABLED=false` sont posés en variables d'environnement
du worker paper agent. Toute tentative d'appel trade exige des secrets absents →
échec fail-closed.

## 1. Ressources déployées (état au 2026-09-04T16:55Z)

| Worker paper | URL | Version déployée |
| --- | --- | --- |
| `dodash-paper-mcp-market-data` | https://dodash-paper-mcp-market-data.guyghost.workers.dev | `e6cbd77c-5767-4349-afb6-4d9f852f29f9` |
| `dodash-paper-agent` | https://dodash-paper-agent.guyghost.workers.dev | `961335c9-847e-46a7-80fe-7369231bfda1` |
| `dodash-paper-dashboard-api` | https://dodash-paper-dashboard-api.guyghost.workers.dev | `f21a03b1-c468-42a9-9000-27dbaea4d2fe` |
| `dodash-paper-dashboard` | https://dodash-paper-dashboard.guyghost.workers.dev | `c1d9227f-e5a8-446c-84e0-bb92ebd0101a` |

- KV dédié : `dodash-paper-market-cache` — ID `abddec98934a40a4b4c85f8d00e5f055`
  (binding `MARKET_CACHE` du worker paper mcp). Le KV production
  `dodash-market-cache` (`72c126510250480580b0115a47a5cbcf`) n'est pas touché.
- Dataset Analytics Engine dédié : `dodash_paper_trading`.
- Service bindings croisés exclusivement entre workers paper
  (`MARKET_DATA`, `AGENT_SERVICE`, `DASHBOARD_API`).
- Configs versionnées : `apps/*/wrangler.paper.jsonc` (jamais les
  `wrangler.jsonc` production).

**Isolation (preuve inventaire avant/après, 2026-09-04 ~16:37Z → ~16:55Z)** :
9 workers avant, 13 après (les 4 nouveaux sont tous préfixés `dodash-paper-*`) ;
1 KV avant, 2 après (le nouveau est `dodash-paper-market-cache`). Aucune autre
ressource du compte modifiée.

## 2. Différences volontaires vs configs production

1. `workers_dev: true` sur les 4 workers paper (les configs production
   mcp/agent/dashboard-api sont `false`) : nécessaire aux health checks et à
   l'API de contrôle. Aucun endpoint sensible n'est accessible sans bearer
   token (`INTERNAL_SERVICE_TOKEN`, `CONTROL_API_TOKEN`,
   `DASHBOARD_ACCESS_TOKEN`) ; le dashboard public est identique à la prod.
2. Flags live verrouillés en `vars` du worker agent (fail-closed, non secrets).
3. Noms, KV et dataset préfixés/dédies `dodash-paper-*`.

## 3. Chemin de reproduction exact

Prérequis : Node 22, pnpm 11.23 (corepack), `wrangler` authentifié sur le
compte, `pnpm install --frozen-lockfile`.

```sh
# 0) Build des paquets workspace — REQUIS (piège n°1 de
#    docs/analysis/analyse-paper-local-2026-09-04.md : sans dist/, le bundling
#    wrangler échoue sur "Could not resolve \"@dodash/domain\"")
pnpm build

# 1) KV paper dédié (si absent) — versionner l'ID dans
#    apps/mcp-market-data/wrangler.paper.jsonc
npx wrangler kv namespace create dodash-paper-market-cache
#    → 2026-09-04 : abddec98934a40a4b4c85f8d00e5f055

# 2) Tokens internes ≥ 32 chars (48 hex ici) — JAMAIS dans le dépôt.
#    PIÈGE n°2 : INTERNAL_SERVICE_TOKEN est PARTAGÉ mcp ↔ agent (même valeur) ;
#    CONTROL_API_TOKEN est PARTAGÉ agent ↔ dashboard-api (même valeur).
T0=$(openssl rand -hex 24)   # INTERNAL_SERVICE_TOKEN  (mcp + agent)
T1=$(openssl rand -hex 24)   # CONTROL_API_TOKEN       (agent + dashboard-api)
T2=$(openssl rand -hex 24)   # DASHBOARD_ACCESS_TOKEN  (dashboard-api)

# 3) Déploiement dans l'ordre du runbook production, secrets après chaque
#    worker, health check avant de passer au suivant.
cd apps/mcp-market-data
npx wrangler deploy -c wrangler.paper.jsonc
printf '%s' "$T0" | npx wrangler secret put INTERNAL_SERVICE_TOKEN -c wrangler.paper.jsonc
curl -s https://dodash-paper-mcp-market-data.guyghost.workers.dev/health

cd ../agent
npx wrangler deploy -c wrangler.paper.jsonc
printf '%s' "$T0" | npx wrangler secret put INTERNAL_SERVICE_TOKEN -c wrangler.paper.jsonc
printf '%s' "$T1" | npx wrangler secret put CONTROL_API_TOKEN -c wrangler.paper.jsonc
curl -s https://dodash-paper-agent.guyghost.workers.dev/health

cd ../dashboard-api
npx wrangler deploy -c wrangler.paper.jsonc
printf '%s' "$T2" | npx wrangler secret put DASHBOARD_ACCESS_TOKEN -c wrangler.paper.jsonc
printf '%s' "$T1" | npx wrangler secret put CONTROL_API_TOKEN -c wrangler.paper.jsonc
curl -s https://dodash-paper-dashboard-api.guyghost.workers.dev/health

cd ../dashboard
npx wrangler deploy -c wrangler.paper.jsonc   # requiert dist/client (pnpm build)
curl -s https://dodash-paper-dashboard.guyghost.workers.dev/health
# (le workers.dev du dashboard peut répondre "error code: 1042" pendant ~20 s
# après le premier déploiement : délai de propagation, réessayer.)

# 4) Preuve paper-only : les secrets de chaque worker doivent lister UNIQUEMENT
#    les tokens internes ci-dessus — aucun secret Coinbase/Hyperliquid.
for app in mcp-market-data agent dashboard-api dashboard; do
  (cd apps/$app && npx wrangler secret list -c wrangler.paper.jsonc)
done

# 5) Instance paper BTC-USD — MODE PORTEFEUILLE N ≥ 2 (dao #43, amendement
#    §11 de models/multi-product-portfolio.md). La voie mono-produit rejette
#    systématiquement en RISK_REJECTED (couture d'admission sans machine
#    portefeuille) : ne plus l'utiliser en production paper.
# 5bis) Instance #36bis (dao #50, arbitrage #36 — répétition générale
#    pré-live) : POST /stop de l'instance 1-min résiduelle PUIS /start
#    aligné sur LIVE_TRADING_POLICY (ONE_DAY, 3 600 s, staleness 2 h,
#    sizing notional — défaut §12 dao #49, redondamment explicite ici).
#    Le corps ONE_MINUTE/60 s de la fenêtre #36 est historique : voir le
#    verdict docs/analysis/analyse-paper-verdict-36-2026-09-18.md et
#    l'historique git du runbook.
T2=…  # recharger le token opérateur
curl -s -X POST https://dodash-paper-dashboard-api.guyghost.workers.dev/api/agents/btc-usd-paper/stop \
  -H "Authorization: Bearer $T2"
curl -s -X POST https://dodash-paper-dashboard-api.guyghost.workers.dev/api/agents/btc-usd-paper/start \
  -H "Authorization: Bearer $T2" -H "Content-Type: application/json" \
  -d '{
    "timeframe": "ONE_DAY",
    "strategyIds": ["breakout", "ema-cross", "rsi-reversion"],
    "intervalSeconds": 3600,
    "maxMarketStalenessMs": 7200000,
    "executionMode": "paper",
    "initialCapital": 10000,
    "maxDecisionNotional": 600,
    "sizingPolicy": {"type": "TARGET_SIGNAL_NOTIONAL", "targetSignalNotional": 1000, "confidenceCalibration": "POWER_THIRD"},
    "products": [{"productId": "BTC-USD", "risk": {"maxOrderNotional": 600}}, {"productId": "ETH-USD", "risk": {"maxOrderNotional": 600}}],
    "portfolioRisk": {"maxGrossExposure": 20000, "maxDailyLoss": 1000}
  }'

curl -s "https://dodash-paper-dashboard-api.guyghost.workers.dev/api/agents/btc-usd-paper/state" \
  -H "Authorization: Bearer $T2"
curl -s "https://dodash-paper-dashboard-api.guyghost.workers.dev/api/agents/btc-usd-paper/cycles?limit=8" \
  -H "Authorization: Bearer $T2"
cd apps/agent && npx wrangler tail dodash-paper-agent --format json   # → "type":"cycle.completed"
```

**Horodatage de début de collecte #36 (télémétrie paper continue, verdict
endpoint à 14 j)** : `2026-09-04T17:01:15Z` (POST /start accepté, instance
reconfigurée en mode portefeuille — voir §4bis). Échéance d'arbitrage :
2026-09-18. La fenêtre ouverte à 16:42:13Z est invalidée par cette
reconfiguration (dao #43) ; c'est l'horodatage 17:01:15Z qui fait foi.

## 4. Épreuve effectuée (2026-09-04)

- 4 workers déployés, 4/4 `/health` → `{"status":"ok",…}`.
- Preuve paper-only (`wrangler secret list`, extrait plafonné) :
  - `dodash-paper-mcp-market-data` : `INTERNAL_SERVICE_TOKEN`
  - `dodash-paper-agent` : `CONTROL_API_TOKEN`, `INTERNAL_SERVICE_TOKEN`
  - `dodash-paper-dashboard-api` : `CONTROL_API_TOKEN`, `DASHBOARD_ACCESS_TOKEN`
  - `dodash-paper-dashboard` : `[]`
  - **Aucun** secret `COINBASE_*` ni `HYPERLIQUID_*`.
- Instance `btc-usd-paper` : `executionMode: "paper"`, machine `waiting`,
  schedule 60 s persisté ; 4 cycles capturés en ~3,5 min via `wrangler tail`
  (≥ 3 requis), ex. :

```json
{"schemaVersion":1,"type":"cycle.completed","timestamp":1788540194548,"agentId":"btc-usd-paper","productId":"BTC-USD","executionMode":"paper","phase":"waiting","outcome":"RISK_REJECTED","errorCode":null,"latencyMs":547,"dailyPnl":0,"accountEquity":10000,"positionQuantity":0,"otherExposureNotional":0,"executionObserved":false,"openOrderCount":null}
```

`RISK_REJECTED` est le refus déterministe du layer risque sur une décision
signaleuse (INV-P5, fail-closed) — aucun ordre placé, `dailyPnl: 0`,
`executionObserved: false` sur tous les cycles. Un cycle a échoué une fois en
`RATE_LIMITED` (phase `market-data`, retryable, rate limit public Coinbase) ;
le cycle suivant a réussi (auto-récupéré).

## 4bis. Incident #43 — RISK_REJECTED systématique (résolu, 2026-09-04)

**Symptôme** : tous les cycles porteurs d'une décision finissent
`RISK_REJECTED` (errorCode `null`) — aucun ordre paper exécuté.

**Cause exacte** (hypothèse sizing réfutée : l'allocateur plafonne déjà le
notional à `min(capitalAvailable, maxDecisionNotional)` = 2 000, `checkRisk`
local approuve) : la couture d'admission consolidée (INV-P5) est câblée sans
condition dans les effets de cycle mono-produit (`createEffects`), alors que
la voie `/start` mono-produit ne crée jamais `portfolioSession` — chaque
`RISK_PROPOSED` reçoit `{approved:false, UNKNOWN_PRODUCT}` (refus fermé),
d'où le rejet systématique.

**Correctif (config d'instance, cœur de risque inchangé)** : redémarrage de
l'instance en **mode portefeuille N ≥ 2** (amendement §11 de
`models/multi-product-portfolio.md`, revu) — créneaux BTC-USD + ETH-USD,
`initialCapital` 10 000/créneau, `portfolioRisk` consolidé
{20 000, 1 000}. Procédure : `POST /stop` puis `POST /start` avec le corps
multi-produits du §3. Le câblage conditionnel de la couture mono-produit
reste un correctif de code à part (passage Model → Review → Implement →
Verify dédié).

**Épreuve** (tail `dodash-paper-agent`, 4 alarmes × 2 produits = 8 cycles) :
4× `ORDER_CONFIRMED` (`executionObserved: true`, positions paper ouvertes :
BTC-USD 0,00853 @ 79 724 ; ETH-USD 0,01538 @ 2 459 ; PnL paper ~-0,60 USD,
cohérent avec frais 6 bps + slippage 2 bps), 1× `NO_ACTION`,
3× `RISK_REJECTED` **ponctuels** (refus déterministes normaux — cooldown /
côté sans position). Plus aucun rejet systématique. Nouvelle fenêtre #36 :
17:01:15Z (§3).

## 5. Coûts attendus (free tier)

Cadence 60 s × 2 créneaux (dao #43) ≈ 2 880 cycles/jour ≈ ~9 000 requêtes/jour
(alarme + fetch marché par produit via service binding + persistance) : très en
dessous des 100 000 requêtes/jour Workers, ~100k points Analytics Engine/jour
et du volume KV. Coût attendu : **0 $** (free tier). Surveillance conseillée à
J+2 : stockage SQLite du DO (historique de cycles) et quota Workers du compte.

## 6. Teardown (collecte #36 close le 2026-09-18T17:01:15Z, verdict rendu ; à ne pas exécuter tant que la fenêtre #36bis court — C3)

Le déploiement doit rester en place ≥ 14 jours (verdict endpoint #36).
Procédure d'arrêt complet, dans l'ordre inverse des dépendances, chaque nom
vérifié par listing avant suppression :

```sh
# Vérifier l'inventaire avant destruction (ne supprimer QUE les 4 noms paper)
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/bab940ffcf652079ec6172c267afa11e/workers/services" \
  | python3 -c "import json,sys; [print(s['id']) for s in json.load(sys.stdin)['result']]"
npx wrangler kv namespace list

cd apps/dashboard       && npx wrangler delete -c wrangler.paper.jsonc   # dodash-paper-dashboard
cd ../dashboard-api     && npx wrangler delete -c wrangler.paper.jsonc   # dodash-paper-dashboard-api
cd ../agent             && npx wrangler delete -c wrangler.paper.jsonc   # dodash-paper-agent
cd ../mcp-market-data   && npx wrangler delete -c wrangler.paper.jsonc   # dodash-paper-mcp-market-data

npx wrangler kv namespace delete --namespace-id abddec98934a40a4b4c85f8d00e5f055
# Re-lister workers + KV : retour à l'inventaire « avant » (9 workers, 1 KV).
```

Arrêt de l'instance seule (sans détruire le déploiement) :

```sh
curl -s -X POST https://dodash-paper-dashboard-api.guyghost.workers.dev/api/agents/btc-usd-paper/stop \
  -H "Authorization: Bearer $T2"
```

## 7. Points ouverts

1. **RISK_REJECTED systématique — RÉSOLU (dao #43, §4bis)** : instance
   reconfigurée en mode portefeuille N ≥ 2 ; exécutions paper observées.
   Restant : les `RISK_REJECTED` ponctuels résiduels sont du comportement
   normal du layer risque (cooldown 60 s, réduction sans position) ; à
   surveiller seulement si leur taux devenait majoritaire.
2. `RATE_LIMITED` ponctuel (retryable) sur la phase `market-data` : à surveiller
   en continu ; rien à faire tant que le taux d'échec reste marginal.
3. Les workers paper exposent `/health` en public (workers.dev) : sans risque
   identifié (aucune donnée), à revoir si le périmètre évolue.
4. **Diagnostic ORDER_REJECTED depuis l'AE (dao #47, 2026-09-19)** : depuis le
   schéma télémétrie v2, blob7 porte le code fin fermé du refus broker
   (`INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION` / …) — plus besoin de lire
   le Durable Object pour qualifier un refus :

   ```sh
   curl -s -X POST \
     https://api.cloudflare.com/client/v4/accounts/bab940ffcf652079ec6172c267afa11e/analytics_engine/sql \
     -H "Authorization: Bearer $CF_OAUTH" -H "Content-Type: text/plain" \
     --data "SELECT blob2 AS product, blob7 AS broker_code, count() AS n \
             FROM dodash_paper_trading \
             WHERE blob1 = 'cycle.completed' AND blob5 = 'ORDER_REJECTED' \
             GROUP BY product, broker_code ORDER BY n DESC"
   ```

   (les cycles antérieurs au redéploiement v2 affichent `NONE` en blob7 ;
   lecture DO réservée aux cas non couverts par le vocabulaire fermé).

## 8. Redéploiement 2026-09-28 — résilience de campagne (segment #36ter)

Source : `docs/analysis/analyse-paper-session-2026-09-28.md` ; conception
`docs/superpowers/specs/2026-09-28-paper-campaign-resilience-design.md`.
Modèles : `models/daily-risk.md`, `models/market-retry-schedule.md`,
`models/cycle-schedule.md`, amendements `agent-runtime.md`, `effects.md`,
`trading-telemetry.md`, `operator-notifications.md`. Aucune modification de
politique (`ONE_DAY`, 3 600 s, fraîcheur 2 h, stratégies, sizing) ni des
secrets ; aucun `/stop`, `/start` ou `/reset` : l'instance `btc-usd-paper` et
ses positions sont conservées.

Contenu livré (tous Workers paper redéployés depuis le même commit) :

1. valorisation datée DAO #62 (`schemaVersion 3`, blob8–10, double11–18) ;
2. fenêtre de risque journalier paper sur le mark daté (fin du repli au coût) ;
3. cache des bougies closes 6 h, `Retry-After` propagé et journal `coinbase_rate_limited` ;
4. retries marché planifiés (60 s / 300 s / 900 s, échéance = fin de fenêtre
   de fraîcheur), alarme ponctuelle `retryTick` ;
5. réveils alignés sur la grille (`1 * * * *` pour 3 600 s) ;
6. événement `decision.missed` et notification `DECISION_WINDOW_MISSED`.

Effets de migration attendus au premier réveil du Durable Object :

- l'ancienne planification `interval` est annulée et remplacée par le cron
  `1 * * * *` : **le réveil horaire qui provoque la migration ne lance pas de
  cycle** (un cycle redondant perdu, hors fenêtre de décision) ; premier cycle
  aligné à `HH:01` suivant ;
- `lastPaperMark` absent ⇒ premier cycle avec valorisation `unavailable`
  (positions ouvertes) et fenêtre journalière portée inchangée, puis mark
  accepté dès le premier snapshot marché ;
- `lastMissedDecisionCandleClosedAt` nul ⇒ aucune alerte rétroactive.

Procédure (ordre du §3, secrets inchangés) :

```sh
pnpm build
cd apps/mcp-market-data && npx wrangler deploy -c wrangler.paper.jsonc
cd ../agent             && npx wrangler deploy -c wrangler.paper.jsonc
cd ../dashboard-api     && npx wrangler deploy -c wrangler.paper.jsonc
cd ../dashboard         && npx wrangler deploy -c wrangler.paper.jsonc
for w in mcp-market-data agent dashboard-api dashboard; do
  curl -s -A "Mozilla/5.0" https://dodash-paper-$w.guyghost.workers.dev/health; echo
done
```

Vérification après le premier cycle aligné (AE, `_sample_interval` à contrôler) :

```sql
SELECT timestamp, blob1, blob2, blob5, blob6, blob8, blob9, double4, double11
FROM dodash_paper_trading
WHERE index1 = 'btc-usd-paper' AND double1 >= <ms du déploiement>
ORDER BY double1 DESC LIMIT 10
```

Attendu : `blob1 = cycle.completed`, `blob8 ∈ {fresh, stale}` après le premier
snapshot accepté, `double4` ≠ 10 000 (équité au mark), réveils à `HH:01`.
Le segment de campagne #36ter commence au premier cycle `schemaVersion 3`
observé ; les fenêtres #36 et #36bis restent archivées telles quelles.
