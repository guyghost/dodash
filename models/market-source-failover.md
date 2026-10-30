# Sources de marché de secours — Hyperliquid et dYdX (failover figé)

Statut : normatif (2026-10-31). Qualification des sources :
`models/market-source-probe.md` (worker diagnostic, sémantiques déjà
observées). Amende le chemin de données de `market-data-integrity.md`
(gardes inchangées) ; aucun état, seuil ni stratégie ne change.

## 1. Constat

Le chemin marché du bot est mono-source : `apps/mcp-market-data` ne sert
que Coinbase. Le 2026-10-30, un throttling Coinbase (429) a mis le paper à
terre pendant des heures (`RATE_LIMITED`/`STALE_MARKET_DATA` en cascade) —
cycles, valorisation et collecte de signaux bloqués, sans alternative. Le
comparateur de sources a déjà qualifié deux secours publics : Hyperliquid
perp (`candleSnapshot` + `allMids`) et dYdX perp (candles + carnet), avec
leurs sémantiques strictes (probe §Sondes figées) : ce sont des venues
**perp**, leurs prix portent un basis variable ; ticker, mid et carnet
sont des mesures distinctes ; seules les bougies closes comptent.

## 2. Décision — résolution pure

Ordre figé par déploiement : `COINBASE → HYPERLIQUID → DYDX`.

```ts
type MarketSourceId = "COINBASE" | "HYPERLIQUID" | "DYDX";

type MarketSourceFailure =
  | "RATE_LIMITED" | "NETWORK_UNAVAILABLE" | "INVALID_RESPONSE"
  | "STALE_SERIES" | "BASIS_REJECTED";

/** Une tentative par source et par requête ; l'ordre ne négocie pas. */
resolveMarketSource(
  order: readonly MarketSourceId[],
  failures: Readonly<Record<MarketSourceId, MarketSourceFailure | null>>,
): { source: MarketSourceId } | { exhausted: true };
```

- Le service marché (`apps/mcp-market-data`) essaie les sources dans
  l'ordre, **une seule tentative chacune** — aucun retry intra-service :
  les budgets de retry restent la propriété exclusive de la machine
  (`market-retry-schedule.md`), inchangés.
- La réponse porte la source utilisée et le statut des sources écartées ;
  l'agent qualifie l'échec total avec les codes fermés existants
  (`RATE_LIMITED`, `STALE_MARKET_DATA`…). Aucun nouveau code machine.

### Gate de basis (perp ≠ spot)

Les secours étant des venues perp, leur série ne peut entrer dans un cycle
sans contrôle : `basisBps = |close_secours − close_coinbase| / close_coinbase`
sur le **même start de bougie close**, la dernière close Coinbase étant lue
dans le cache du service (âge ≤ `BASIS_REFERENCE_MAX_AGE_MS`). Rejet
`BASIS_REJECTED` (donc source écartée, source suivante essayée) au-delà de
`BASIS_MAX_BPS`. Sans référence Coinbase disponible, un secours n'est
**jamais** servi : fail-closed. La comparaison de closes utilise le même
start de bougie, jamais un ticker (probe).

## 3. Sémantiques transport (du probe, normatives ici)

- **Hyperliquid** : bougies via `candleSnapshot` (granularité mappée sur la
  grille du produit) ; prix via `allMids` (mid, ou dernier trade si carnet
  vide). BTC et ETH seulement dans le plan initial.
- **dYdX** : bougies avec `toISO` fixé à la clôture de fenêtre (borne de
  start exclusive) ; bougie en cours toujours exclue ; prix = moyenne du
  meilleur bid/ask non croisé.
- OHLCV validés (`createCandle`), starts attendus exactement une fois
  (manquants/doublons comptés), alignement UTC. User-Agent diagnostic
  fixe et transparent ; aucune rotation d'identité, aucun contournement
  de limiteur ; réponse ≤ 2 MiB ; timeout ≤ 10 s ; redirects refusés.
- Aucun secret : endpoints publics uniquement.

## 4. Mécanique shell et étiquetage

- `MarketSnapshot.source` s'élargit à `MarketSourceId` (les consommateurs
  lisent un libellé, jamais une stratégie de source). La télémétrie du
  cycle porte la source (champ existant `valuationPriceSource` complété
  d'un `marketSource`) ; les collecteurs de signaux héritent du failover
  sans changement.
- La gate de cohérence ticker↔close de `market-data-integrity.md` reste
  **intra-source** : le ticker du snapshot est comparé à la close de la
  même série, jamais à celle d'une autre venue.
- Les indicateurs et stratégies ne changent pas : le cœur pur consomme
  des `Candle` typés, indifférents à la provenance (INV 8 de
  `README.md`).

## 5. Invariants

1. Une série de bougies ne mélange jamais deux sources ; le snapshot
   porte sa source, unique pour tout le cycle (décision, valorisation,
   risk).
2. L'ordre de failover est figé par déploiement ; une tentative par
   source et par requête ; la machine reste seule propriétaire des
   re-tentatives.
3. Un secours perp n'est servi qu'avec une référence Coinbase fraîche et
   un basis ≤ `BASIS_MAX_BPS` ; sinon source écartée, jamais servie.
4. Bougies closes uniquement ; ticker/mid/carnet = mesures distinctes,
   jamais interchangeables ; cohérence ticker intra-source.
5. Échec de toutes les sources ⇒ codes fermés existants, fail-closed ;
   aucune donnée périmée ou non validée n'atteint les indicateurs.
6. Aucun secret, aucun endpoint privé ; User-Agent transparent.
7. Aucune transition, garde ou seuil de `tradingCycleMachine` ne change.

## 6. Vérification requise

- `resolveMarketSource` : ordre respecté, échec total fermé, source
  primaire saine jamais contournée.
- Gate basis : rejet au-delà de la borne ; sans référence Coinbase →
  secours jamais servi ; comparaison au même start de bougie.
- Fetchers Hyperliquid/dYdX sur fixtures figées : mapping granularité,
  `toISO` dYdX (bougie en cours exclue), doublons/manquants, prix
  mid/carnet distincts, body trop grand, JSON invalide, timeout.
- Étiquetage : snapshot + télémétrie portent la source ; aucun mélange
  de série (test d'architecture) ; un cycle entier servi par une seule
  source.
- Aucune modification de machine (diff des transitions/gardes).
