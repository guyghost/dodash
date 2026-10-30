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
