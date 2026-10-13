# Comparaison réelle depuis Cloudflare — 13 octobre 2026

## Résultat provisoire

**Les 429 ne sont pas limités à Coinbase Advanced : Coinbase Exchange en
renvoie aussi depuis le Worker diagnostic.** Hyperliquid direct et dYdX
fournissent les 240 bougies daily closes BTC/ETH dans le lot corrigé.
Pas de changement de fournisseur du bot, d'ordre, de transfert ou de preuve
de rentabilité. Une observation ponctuelle ne suffit pas à choisir une venue.

## Environnement et campagne

- Worker distinct `dodash-market-source-probe-20261013`, sans binding du bot.
- Version finale initiale : `b3d4c8eb-f81c-4020-8357-aa8729fc5d84`.
- Code local vérifié et commité : `0041a41` ; aucun push. Déploiement réalisé
  avant ce commit, à code identique ; empreinte du bundle local archivée.
- Fenêtre : **2026-10-13 21:04:46.713 → 2026-10-14 21:04:46.713 UTC**.
- Cron **HH:11 UTC**, décalé du réveil HH:01 du bot. Pas de mesure à 00:01
  dans ce lot ; la fenêtre daily à 00:11 reste à observer.
- POST protégé par un token diagnostic aléatoire, transmis via stdin, non
  archivé. Health public sans effets ; requêtes avec contenu refusées.
- 15 appels maximum par lot, séquentiels, aucun retry amont ; un 429 bloque
  les autres appels au même fournisseur dans le lot. Expiration sans
  prolongation automatique. Worker/cron restent installés après expiration.
- Captures manuelles : colo d'entrée **BOS**. Ce n'est pas une preuve d'IP de
  sortie identique à celle du DO du bot ; un quota partagé reste possible.

## Captures HTTP

Fenêtre commune de bougies : 240 jours avant le **13 octobre 00:00 UTC**,
dernière bougie start **12 octobre 00:00 UTC**. Parsing OHLCV strict, starts
UTC uniques et sans trou. Les bougies ouvertes sont exclues.

### Lot initial réseau — 21:08:28 UTC

Run `b6a3c40f-8853-4207-ad92-7107a9d4141a` :

- Advanced : BTC candles/quote 200 ; ETH candles **429**, sans Retry-After ;
  quote ETH ignorée, pas un 429 supplémentaire.
- Exchange : quotes 200 ; candles **400**. Non concluant pour la disponibilité.
- Hyperliquid : candles BTC/ETH 200, 240/240 closes ; allMids 200.
- dYdX : candles 200, 239/240 starts ; le dernier start absent est exactement
  la borne toISO envoyée. Quotes 200. Ce trou ne prouve pas une panne amont.

### Lot corrigé — 21:09:50 UTC

Run `9e22b46f-4914-4c05-899a-290dec13488a`, durée 3 633 ms :

| Fournisseur | Bougies BTC | Bougies ETH | Quotes | Latence candles BTC / ETH |
|---|---|---|---|---|
| Coinbase Advanced spot | 200, 240/240 | 200, 240/240 | BTC/ETH 200 | 77 / 66 ms |
| Coinbase Exchange spot | 200, 240/240 | **429** | BTC 200, ETH ignorée | 9 / 31 ms |
| Hyperliquid perp | 200, 240/240 | 200, 240/240 | allMids 200 | 181 / 172 ms |
| dYdX perp | 200, 240/240 | 200, 240/240 | BTC/ETH carnet 200 | 949 / 876 ms |

Le 429 Exchange porte `cf-cache-status: BYPASS`, sans Retry-After, comme celui
d'Advanced du lot initial. Les faibles latences ne prouvent pas un fetch
non caché ; ne pas comparer ces nombres comme des percentiles de SLA.

Derniers closes comparés à Advanced, au même start :

| Fournisseur | BTC, écart bps | ETH, écart bps |
|---|---:|---:|
| Exchange | 0 | non observé (429) |
| Hyperliquid | +8,50 | +5,32 |
| dYdX | +8,62 | +2,05 |

Les écarts spot/perp sont attendus et ne rendent pas les séries substituables.
Quote Advanced/Exchange = last ; Hyperliquid = mid ou last selon l'API ;
dYdX = mid du meilleur carnet. Horodatage amont absent reste null, jamais
remplacé par le fetch. Base n'est pas une source de données alternative.

### Cron : non observé dans la capture initiale

La capture tail bornée de 150 secondes autour de HH:11 ne contient aucun
rapport `market_source_probe.completed`. **Ne pas en déduire une panne ni
inventer une exécution** : la propagation des Cron Triggers peut prendre
jusqu'à 15 minutes selon Cloudflare. La campagne reste active jusqu'à son
expiration ; une exécution cron réelle et la clôture daily restent à vérifier.

## Corrections révélées par la vérification

1. Cloudflare expose parfois un stream vide pour POST : accepter uniquement
   la fin de flux dès la première lecture, refuser tout chunk client.
2. Workerd refuse `redirect: error` avant le réseau : `manual` sans suivi des
   3xx. Le run pré-correction `58048a42-1244-4cd8-ab41-b28ac8173cc1` contient
   15 NETWORK_ERROR immédiats ; **ce n'est pas une mesure de panne des venues**.
3. User-Agent diagnostic fixe ajouté. Exchange candles répond ensuite 200
   pour BTC ; la cause des 400 initiaux n'est pas prouvée, faute de body capturé.
4. dYdX toISO porté à la clôture de fenêtre, au lieu du dernier start attendu.
   Les 240 starts sont alors présents ; pas de mélange ni de remplissage.

Des refus 401/400 et un health immédiatement encore inactif ont également été
vus pendant la propagation des déploiements/secrets. Les refus n'ont déclenché
aucun appel amont. Aucun secret n'est conservé dans les captures.

## Vérification et suites

- Modèle XState et revue avant implémentation ; tests expiration et blocage429.
- Tests unitaires de plan, auth, normalisation, erreurs, bornes et timeout.
- Smoke test du **bundle sous workerd**, avec amont remplacé et redirect hostile.
- Suite globale réussie avant déploiement ; TypeScript, build dry-run,
  scan secrets, lint ciblé et audit sans vulnérabilité high/critical.
- Suite globale relancée après corrections : 526 tests modèles, 313 tests
  agent et 15 tests comparateur passent ; build global dry-run réussi.
- Lint global toujours limité par le JSON concaténé préexistant du 8 octobre,
  laissé intact. Audit : 11 vulnérabilités moderate, hors correction de ce lot.

Prochaine décision : analyser les crons observés, surtout après clôture daily,
avant de choisir une campagne spot Exchange ou perp Hyperliquid/dYdX. Les
429 des deux Coinbase rendent un basculement automatique prématuré. La
télémétrie paper v4 reste non déployée : l'autorisation présente ne concerne
pas le bot.

Captures et SHA-256 : `evidence-cloudflare-market-source-2026-10-13/`.
Runbook/arrêt : `docs/operations/market-source-probe.md`.

## Sources officielles

- Cloudflare Cron : https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare standards/runtime : https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- Coinbase requests : https://docs.cdp.coinbase.com/exchange/rest-api/requests
- dYdX candles/orderbook : https://docs.dydx.xyz/indexer-client/http/markets
- Hyperliquid info : https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
