# Revue — sources de marché de secours Hyperliquid/dYdX (2026-10-31)

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE** (opérateur, 2026-10-31).

- Résolution pure figée dans `models/` (ordre, échec total fermé) ; une
  tentative par source par requête ; les budgets retry restent à la
  machine — discipline `market-retry-schedule.md` intacte.
- Gate de basis obligatoire avant tout service d'un secours perp, contre
  une référence Coinbase fraîche, comparaison au même start de bougie —
  sans référence, fail-closed. Bornes retenues : `BASIS_MAX_BPS = 200`,
  `BASIS_REFERENCE_MAX_AGE_MS = 600_000` (10 min).
- Sémantiques transport reprises telles quelles du comparateur
  (candleSnapshot/allMids, toISO dYdX exclusif, mid bid/ask, mesures
  distinctes, bougies closes uniquement) — zéro redécouverte.
- Aucun changement de machine : échec total ⇒ codes fermés existants ;
  gardes `market-data-integrity.md` inchangées (ticker↔close intra-source).
- BTC/ETH au plan initial ; endpoints publics ; User-Agent transparent.

## Notes d'implémentation acceptées

- L'endpoint interne du service marché accepte un tableau `sources`
  optionnel (défaut : l'ordre figé) — outil opérateur pour valider chaque
  source isolément ; le plan public du comparateur, lui, n'accepte rien.
- La référence de basis lit le cache KV existant du service (dernières
  bougies Coinbase), sans nouvel appel amont.
- `MarketSnapshot.source` s'élargit ; la télémétrie porte la source du
  cycle via un champ optionnel — projection additive, aucun blob
  existant décalé.
- La vérification « un cycle entier servi par une seule source » est
  portée par la construction (le snapshot porte sa source, les effets ne
  la changent jamais) et un test d'architecture sur l'absence de re-fetch
  de source en cours de cycle.

## Vérification requise (§6) → couverture de tests

| Item | Tests |
|---|---|
| Ordre respecté, échec total fermé, primaire sain jamais contourné | `market-source-failover.test.ts` |
| Gate basis : rejet hors borne, sans référence jamais servi, même start | idem |
| Fetchers HL/dYdX fixtures figées (mapping, toISO, doublons, prix, bornes) | tests mcp `hyperliquid`/`dydx` |
| Étiquetage source + aucune modification de machine | diff machine nul + test transport agent |

## Amendement 2026-11-14 — fenêtre de décision et `RATE_LIMITED`

Verdict : **APPROUVÉ POUR IMPLÉMENTATION LOCALE**. Pas de déploiement, pas
de passage en live. La machine `tradingCycleMachine` ne change pas.

### Cause

Le secours est bien appelé par `handleInternalRequest` après un 429
Coinbase, puis rejeté avant d'être servi.

1. `serveBackupCandles` (`apps/mcp-market-data/src/failover.ts`) compare
   la **dernière** close du secours à la référence Coinbase. Cette
   dernière close est la bougie que Coinbase vient de refuser : la
   référence en cache, écrite seulement après un succès, porte le start
   de la bougie précédente. `assessBasisGate` rend `NO_REFERENCE`
   (`models/market-source-failover.ts`, starts différents). Le worker
   replie ça en `BASIS_REJECTED`.
2. L'âge maximal était 4 h. La référence d'une décision `ONE_DAY` a ~24 h
   au réveil suivant (00:01 UTC), donc périmée même si les starts
   coïncidaient.
3. L'épuisement restitue `lastCoinbaseError` (`apps/mcp-market-data/src/index.ts`) :
   l'agent voit `RATE_LIMITED` et aucun snapshot de secours.
4. `fetchMarketSnapshot` écrivait `valuationMark.source =
   "COINBASE_CANDLE_CLOSE"` quel que soit `parsed.data.source`. Une
   décision servie par un secours resterait étiquetée Coinbase. Les marks
   observés `COINBASE_CANDLE_CLOSE` ne prouvent donc pas que le secours
   n'a pas été tenté ; ils prouvent qu'il n'a pas été servi, et que
   l'étiquette ne pouvait pas dire le contraire.

Le décalage portefeuille de 2 s sérialise déjà BTC puis ETH. Il ne couvre
pas le ticker du premier produit ni un 429 qui dure. ETH reste le second
appel et concentre les `RATE_LIMITED`.

### Décision

- Gate sur la bougie de secours au **start de la référence**, puis service
  de la série entière si le basis ≤ 200 bps. Sans recouvrement, sans
  référence, ou au-delà de 8 jours : fail-closed, inchangé.
- Backoff intra-requête réservé à `RATE_LIMITED` Coinbase : 3 essais,
  bases 400 ms et 1 200 ms, gigue ±25 % injectée, plafond 1 500 ms,
  budget 2 500 ms. `Retry-After` plus long → pas d'attente, failover.
  La machine garde les retries de cycle (60 s / 300 s / 900 s).
- Décalage de grille : 8 s ±25 % (6–10 s) avant le produit suivant.
  `runNow` et les retries de cycle ne sont pas décalés.
- Le mark et `valuationPriceSource` portent
  `HYPERLIQUID_CANDLE_CLOSE` ou `DYDX_CANDLE_CLOSE` quand cette série a
  servi. La décision reste celle de la machine sur les bougies closes.

### Hors périmètre

Aucun secret, aucun déploiement, `LIVE_TRADING_ENABLED` inchangé. Pas de
nouvelle transition. Le résidu accepté : un secours dont l'ancre a
plusieurs jours peut porter un basis plus récent non mesuré ; l'étiquette
du mark le dit, et l'absence d'ancre reste un échec fermé.
