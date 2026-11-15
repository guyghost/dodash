# 429 Coinbase, couverture daily et alternatives — 13 octobre 2026

## Conclusion

**Ne pas changer automatiquement de marché pour traiter les 429.** La nouvelle
capture montre une décision compatible pour **12 fenêtres-produit sur 12**
(8–13 octobre), malgré des erreurs `RATE_LIMITED` persistantes. Les reprises
planifiées semblent récupérer les fenêtres daily ; l'état HTTP des appels
marché et l'admission exacte des décisions restent des mesures distinctes.

Pour conserver la campagne spot Coinbase, **Coinbase Exchange est le premier
candidat de comparaison**. Pour une future campagne perp dédiée,
**Hyperliquid direct est le candidat le plus proche de l'infrastructure
existante**, avec dYdX comme alternative indépendante. Base peut servir de
route de dépôt vers HyperCore ; ce n'est pas une autre API de données Hyperliquid.

Périmètre : diagnostic réseau et lecture de télémétrie, aucune activation,
modification de configuration, transaction, déploiement ni collecte économique
destinée à recalibrer une stratégie. Protocole figé avant collecte :
`models/market-availability-diagnosis.md`.

## 1. Preuves et déploiements

Capture locale archivée dans `evidence-market-availability-2026-10-13/` :

- `capture.json` : sondes publiques et métadonnées de déploiement ;
- `analytics-retry.json` : requête SQL et 301 lignes AE, dont 300 cycles ;
- `coverage.json` : fenêtres indépendantes des lignes reçues, proxy de couverture ;
- `deployment-segments.json` : erreurs de cycle par segment de déploiement ;
- `provider-comparison.json` : comparaison de closes, uniquement bougies closes ;
- `coinbase-end-boundary.json` : sondes complémentaires des bornes ;
- `live-market-tail.json` : journal Worker du 13 octobre, champs de marché
  autorisés uniquement, aucun header d'authentification ;
- `sha256.json` : empreintes des fichiers JSON.

Début de fenêtre : 7 octobre, 22:39:32 UTC. Fin : capture du 13 octobre vers
19:51 UTC. Deux déploiements agent sont présents sur cette fenêtre :

| Déploiement | Version agent | Version marché |
| --- | --- | --- |
| 7 octobre vers 22:39 UTC | `5c23a1bb-5074-4f1f-9d61-0e6bad45d3d8` | `9c652792-1eab-4302-8cb2-8d1af1c2cc96` |
| 10 octobre vers 17:27 UTC | `ba253e7c-3e86-4565-add2-ab8ce6ba9605` | `f6eb430a-fabe-402d-acc7-2d3e2eb95304` |

Les configurations de stratégie n'ont pas été lues : ne pas déduire une
activation P7 du seul déploiement du 10 octobre.

Les commits locaux `fc42f9a` et `fa738f8` n'ont pas été déployés par cette
session. Cette capture ne constitue donc pas leur vérification en production.

Accès : OAuth Wrangler local rafraîchi via `wrangler whoami` après un 401 ;
aucun secret copié dans les preuves. Premier SQL refusé (422) : AE demandait
`ORDER BY ts`, l'alias sélectionné, et non `ORDER BY double1`. La réponse
initiale est conservée ; la requête corrigée est archivée séparément.

## 2. Couverture des décisions — résultat conservateur

La période contient six fenêtres daily entièrement écoulées, du 8 au
13 octobre, pour BTC et ETH : **12 attendues**, indépendamment des cycles
présents ou absents dans Analytics Engine.

| Mesure | Résultat |
| --- | ---: |
| Fenêtres-produit attendues | 12 |
| Fenêtres avec décision compatible observée | **12 / 12 (100 %)** |
| Lignes `cycle.completed` | 300 |
| Lignes de cycle portant `RATE_LIMITED` | 100 / 300 |
| Cycles `FAILED/RATE_LIMITED` | 72 / 300 |
| Cycles `FAILED/STALE_MARKET_DATA` | 70 / 300 |
| Événements `decision.missed` | 1 |
| Lignes AE avec poids d'échantillonnage > 1 | 2 |

**Ces 100 lignes ne sont pas 100 réponses HTTP 429.** Une ligne peut représenter
un retry en attente, conserver une erreur passée après succès, ou couvrir
plusieurs appels. Il serait faux d'en déduire un taux HTTP de 33 %.

| Segment | Cycles | Avec `RATE_LIMITED` | `FAILED/RATE_LIMITED` |
| --- | ---: | ---: | ---: |
| Après déploiement du 7 octobre, avant celui du 10 | 140 | 38 | 26 |
| Après déploiement du 10 octobre | 160 | 62 | 46 |

Le proxy exige une issue terminale compatible, un mark `fresh` portant le
close UTC attendu et une fin d'événement au plus tard à 02:00 UTC. Il ne compte
qu'une fois chaque produit/close. Les jours sans ligne restent au dénominateur.

**Limite :** AE ne transporte pas `cycleId`, `triggeredAt` ou
`lastDecisionCandleClosedAt`. Les 12 fenêtres sont donc une observation
compatible, pas 12 admissions indépendamment prouvées par la machine.
L'unique `decision.missed` n'est pas attribué au jour de son émission : une
reprise peut franchir minuit, et une admission tardive peut masquer une perte
réelle. Les deux poids > 1 empêchent également une preuve d'absence exacte.

Le résultat 3/18 du rapport du 7 octobre portait sur la période **avant** le
correctif d'alarme anticipée. Il ne décrit plus la nouvelle période. Il faut
garder ces segments séparés, sans extrapoler un edge économique de leur couverture.

## 3. Diagnostic des 429

### Ce qui est établi

Les journaux archivés du Worker marché du 7 octobre vers 22:40–23:08 donnent
16 requêtes instrumentées, comptées uniquement sur `coinbase_market_request`
(sans compter une seconde fois les journaux d'erreur du même appel) :

| Type | Cache | HTTP | Nombre |
| --- | --- | ---: | ---: |
| Bougies | miss | 429 | 4 |
| Bougies | miss | 200 | 2 |
| Bougies | hit | aucun appel amont | 4 |
| Ticker | miss | 200 | 6 |

Les quatre 429 n'ont pas de `Retry-After`. **Le ticker n'est donc pas la cause
unique démontrée : les 429 observés ici touchent les bougies.** La petite fenêtre
ne prouve pas le taux à long terme ni la cause du limiteur Coinbase.

### Confirmation live depuis Cloudflare, 13 octobre

Un tail borné de 330 s (19:56:12–20:01:42 UTC) a capturé le réveil 20:01
de la version marché `f6eb430a-fabe-402d-acc7-2d3e2eb95304` :

| Requête | Cache | Statut |
| --- | --- | --- |
| Bougies BTC | hit | aucun appel amont |
| Ticker BTC | miss | **200**, 240 ms |
| Bougies ETH | hit | aucun appel amont |
| Ticker ETH | miss | **429**, 216 ms, sans `Retry-After` |

Quatre requêtes instrumentées, dont deux appels HTTP amont. Le journal
`coinbase_rate_limited` du même ticker ETH n'est pas compté comme une cinquième
requête. Les deux tickers sont espacés d'environ 2,3 s : le décalage des produits
ne suffit pas à éliminer tous les 429. **Bougies et ticker sont tous deux
concernés selon les fenêtres ; le problème est encore observable depuis le
Worker, alors que les sondes locales réussissent.** Un seul tick ne mesure pas
le quota ou le taux d'erreur long terme. Ce tail est postérieur à la fenêtre AE
de couverture, et hors fenêtre de décision daily.

Le code actuel appelle Coinbase Advanced public sans JWT, avec cache KV
par produit/fenêtre. Les requêtes à nouvelle bougie ne peuvent pas utiliser
la clé historique précédente. Un cache long ne supprime donc pas la première
requête quotidienne, précisément celle dont la réussite importe.

### Ce qui reste une hypothèse

Quota d'IP de sortie partagé, limiteur de protection amont, burst d'autres
consommateurs ou cache miss : **aucune attribution causale précise n'est
prouvée**. Il manque une observation du quota effectif et des appels Worker
sur une fenêtre plus longue. L'IP d'une sonde locale n'est pas celle du Worker.

La documentation Coinbase Exchange publie 10 requêtes/s/IP, burst 15, mais
ces nombres ne doivent **pas** être appliqués au endpoint Advanced utilisé ici.
La documentation Advanced consultée ne donne pas de quota numérique REST
public vérifiable pour ce diagnostic. Aucune promesse « authentifier suffira ».

### Sondes publiques locales

Huit requêtes initiales, une par source et produit, ont toutes retourné 200 :
Advanced, Exchange, Hyperliquid perp et dYdX perp, BTC et ETH. Deux sondes
Advanced supplémentaires des bornes ont également retourné 200. Aucun retry,
rotation d'IP, proxy ou clé n'a été utilisé. Ces sondes montrent la disponibilité
ponctuelle depuis le Mac, pas une SLA ni la disparition des 429 depuis Cloudflare.

La réponse Advanced avec `end = début de la dernière bougie close` inclut cette
bougie dans l'échantillon. Avec `end = minuit courant`, elle inclut une bougie
en cours : après filtrage, il ne reste que deux bougies closes pour `limit=3`.
**Ne pas changer les bornes sur l'hypothèse non vérifiée d'un `end` exclusif.**

## 4. Options de données et d'exécution

| Option | Atout pour DoDash | Limites / changement requis |
| --- | --- | --- |
| Coinbase Advanced | Source actuelle, même campagne | 429 encore observés ; disponibilité Worker à mesurer |
| Coinbase Exchange | Même exchange spot USD, API publique distincte ; closes identiques sur les trois bougies communes sondées | Nouvel adapter, pagination (max 300 bougies par appel documenté), quotas et validation de parité ; pas de fallback activé |
| Hyperliquid direct | API `/info`, bougies + WebSocket ; execution perp et funding déjà partiellement intégrés | Adapter de bougies absent ; prix perp/spot et USD/USDC à distinguer ; 5 000 dernières bougies disponibles |
| Hyperliquid via Base | Route de dépôt USDC vers HyperCore documentée | N'améliore pas le quota de `/info` ; coûts/risques de transfert supplémentaires ; inutile pour une lecture de données |
| dYdX | Source perp indépendante, Indexer REST/WebSocket, bougies et funding | Pas d'intégration dans le dépôt ; nouvel adapter et, pour trader, signing/réconciliation/risque sur dYdX Chain |

Hyperliquid applique un budget REST **pondéré par IP** de 1 200/min :
`candleSnapshot` n'est pas une requête de poids 1 (poids de base 20 et poids
additionnel selon le nombre de bougies). Changer de fournisseur ne supprime
donc pas le besoin de cache et de budget de requêtes. `allMids` a un poids 2,
mais un mid n'est pas un close ni un prix d'exécution garanti.

dYdX fournit `resolution`, `fromISO`, `toISO` et `limit` pour ses bougies perp.
Le quota de l'Indexer de production n'a pas été confirmé ; ne pas confondre
ses limites HTTP avec les limites de transactions de la chaîne. Il faut aussi
vérifier son retard d'indexation avant d'utiliser le carnet pour exécuter.

Attention aux granularités : Hyperliquid ne documente pas d'intervalle natif
`6h`, alors que DoDash connaît `SIX_HOUR`. Ce diagnostic porte sur `ONE_DAY` ;
un éventuel adapter 6 h doit modéliser une agrégation causale de bougies
complètes, pas traduire silencieusement 6 h en 4 h ou 8 h.

### Différences de prix réellement observées

Dernier close commun : bougie du 12 octobre, close au 13 octobre 00:00 UTC.
Différence relative au close Coinbase Advanced :

| Source | BTC | ETH |
| --- | ---: | ---: |
| Coinbase Exchange | 0 bps | 0 bps |
| Hyperliquid perp | +8,50 bps | +5,32 bps |
| dYdX perp | +8,62 bps | +2,05 bps |

Ce petit échantillon ne démontre pas une équivalence durable. Les perps
introduisent basis, funding, marge et liquidation. Le spot Hyperliquid peut
aussi porter un actif représenté (par exemple UBTC), pas le même instrument
Coinbase BTC-USD. **Ne jamais mélanger des bougies spot et perp dans la même
fenêtre, ni changer de source sans en conserver la provenance.**

## 5. Prochain lot recommandé — proposition, non implémenté

1. **Mesure exacte des décisions** : modéliser une télémétrie d'admission avec
   produit, cycle, close de décision et instant d'évaluation, ainsi que le close
   original de `decision.missed`. Dédupliquer par produit/close, pas par heure.
2. **Comparaison shadow données**, sans trading : Coinbase Exchange pour la
   campagne spot, Hyperliquid `/info` comme candidat à une campagne perp séparée.
   Collecter depuis le même environnement Cloudflare, cache hit/miss, statuts,
   fraîcheur, bougies manquantes, continuité et divergences, notamment à 00:01.
3. Après résultats, choisir un adapter sous **Model → Review → Implement → Verify**.
   Aucun basculement automatique ou abaissement des gardes de fraîcheur/divergence.
   dYdX reste une troisième option, à instrumenter indépendamment si nécessaire.

## 6. Sources officielles consultées

- Coinbase Advanced public/private, cache et WebSocket :
  https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
- Paramètres des bougies Advanced :
  https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles
- Coinbase Exchange rate limits (API distincte) :
  https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits
- Bougies Exchange, limite 300 :
  https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
- Hyperliquid info, bougies et distinction perp/spot :
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Hyperliquid quotas :
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Hyperliquid onboarding, route USDC depuis Base :
  https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-start-trading
- dYdX bougies : https://docs.dydx.xyz/indexer-client/http/markets
- dYdX Indexer et chaîne : https://docs.dydx.xyz/concepts/architecture/overview

## 7. Reproduction et vérification

```sh
# Hors réseau : six tests de métriques/normalisation/parsing
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s docs/analysis -p test_market_availability.py
# Hors réseau : rejoue les métriques depuis les captures archivées
PYTHONDONTWRITEBYTECODE=1 python3 docs/analysis/market-availability-2026-10-13.py \
  --output docs/analysis/evidence-market-availability-2026-10-13 --replay
# Réseau : choisir un répertoire nouveau pour ne pas écraser les preuves
PYTHONDONTWRITEBYTECODE=1 python3 docs/analysis/market-availability-2026-10-13.py \
  --output docs/analysis/evidence-market-availability-NOUVELLE-CAPTURE
# Journal live borné, Worker déjà déployé, sans déclencher de cycle
PYTHONDONTWRITEBYTECODE=1 python3 docs/analysis/market-availability-2026-10-13.py \
  --output docs/analysis/evidence-market-availability-NOUVELLE-CAPTURE --tail-seconds 330
```

Les tests de mesure passent ; aucun test de trading réel ni changement du
runtime n'est revendiqué. Les preuves locales préexistantes des 7–8 octobre
ont été consultées, jamais modifiées.

## 8. Suivi du lot Cloudflare — 21:09 UTC

Le comparateur shadow isolé a été autorisé et déployé, sans modification du
bot. Deux lots réseau observent un 429 Advanced puis un 429 Exchange ;
Hyperliquid et dYdX fournissent 240/240 closes BTC/ETH après correction des
bornes dYdX. Exchange n'est donc pas une solution garantie aux 429. Les
crons et la prochaine clôture daily restent à observer ; pas de SLA conclue.
Rapport et preuves : `docs/analysis/cloudflare-market-source-2026-10-13.md`.
