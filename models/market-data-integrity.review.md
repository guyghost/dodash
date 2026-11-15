# Revue du modèle — intégrité des données de marché

## Couverture

| Cas | Rejet attendu | Chemin fermé | Décision |
| --- | --- | --- | --- |
| Série conforme (live) | aucun | `MARKET_DATA_READY`, comportement bit-identique | Couvert (INV-I6) |
| Bougie manquante au milieu | `CANDLE_GAP { index }` | `MARKET_DATA_FAILED` / `INVALID_RESPONSE` non retryable, aucun ordre | Couvert |
| Timestamps désordonnés | `INVALID_SERIES` (cause `UNSORTED_CANDLE_SERIES { index }`) | idem | Couvert (code existant, non dupliqué) |
| Bougie dupliquée | `INVALID_SERIES` (cause `DUPLICATE_CANDLE { index }`) | idem | Couvert (code existant, non dupliqué) |
| Série vide | `INVALID_SERIES` (cause `EMPTY_CANDLE_SERIES`) | idem | Couvert |
| Ticker divergent (> 100 bps) | `TICKER_INCOHERENT { divergenceBps, maxDivergenceBps }` | `MARKET_DATA_FAILED` / `STALE_MARKET_DATA` retryable → retry borné puis `failed`, aucun ordre | Couvert |
| Ticker à la borne (100 bps exacts) | conforme | cycle nominal | Couvert |
| Prix ticker non fini / ≤ 0 | `TICKER_INVALID_PRICE` | `INVALID_RESPONSE` non retryable | Couvert |
| Ticker indisponible (réseau/429/5xx) | — | classes réseau existantes, retry borné | Couvert |
| Ticker absent sur le chemin live | interdit | rejet fail-closed (INV-I7), jamais de contrôle silencieusement ignoré | Couvert |
| Cadence déclarée invalide | `INVALID_INTERVAL` | `INVALID_RESPONSE` non retryable | Couvert |
| Rejeu : décision trouée | `CANDLE_GAP` | `INVALID_CANDLES`, zéro trade | Couvert |
| Rejeu : exécution trouée | `CANDLE_GAP` | `INVALID_EXECUTION_CANDLES` | Couvert |
| Rejeu : `executionCandles` sans `executionIntervalMs` | rejet fermé | `INVALID_EXECUTION_CANDLES` | Couvert (fail-closed à l'exécution) |
| Données périmées (âge) | inchangé | garde d'âge `isFreshMarketData` existant, non touché | Couvert (non-duplication, INV-I4) |

## Contraintes de mise en œuvre

- La validation est une fonction pure de `@dodash/domain` : ni horloge,
  ni I/O, ni LLM. Les adapters traduisent une cause fermée en
  `WorkflowError` existant ; l'interpréteur et la machine restent
  inchangés (aucun nouvel état, aucune garde, aucun code nouveau).
- Ordre de vérification figé : intervalle → structure (codes existants
  `validateCandleSeries`) → continuité → ticker ; premier échec
  gagnant, index de la bougie fautive conservé.
- Seuils : `MAX_TICKER_DIVERGENCE_BPS = 100` et `TIMEFRAME_MILLISECONDS`
  portés par `@dodash/domain` seuls ; toute autre occurrence serait une
  divergence interdite (C2).
- Au rejeu, la couche modélisée (`suite.ts`) dérive `intervalMs` de
  `dataset.timeframe` ; le replay n'infère jamais la cadence depuis les
  données (auto-référence interdite, fail-closed).

## Points signalés en revue (conformément au critère de branchement)

1. **Aucune retouche machine requise** : le branchement se fait
   entièrement dans l'adapter (`fetchMarketSnapshot`) et le replay —
   au-delà d'un rejet de données typé existant (`MARKET_DATA_FAILED`),
   la machine n'est pas modifiée. Le garde d'âge n'est pas dupliqué.
2. **Sémantique terminale de la divergence ticker** : la péremption
   d'âge aboutit à `NO_ACTION` (chemin `MARKET_DATA_READY` de la
   machine) tandis que la divergence ticker, portée par
   `MARKET_DATA_FAILED`, aboutit à `failed` après retry borné. C'est la
   conséquence directe de l'emprunt du chemin existant sans nouvel
   état ; accepté (donnée incohérente = donnée à rejeter durement,
   opérateur informé via `lastError`), à réévaluer si un jour la
   divergence doit être traitée comme une simple indisponibilité.
3. **Coût réseau live** : un second appel (`/internal/ticker`) par
   cycle, servi par le cache KV du worker ; les tests adaptent leurs
   doubles de `fetch` en conséquence.
4. **Surface de configuration rejeu** : `BacktestConfig.intervalMs` et
   `BacktestReplayOptions.executionIntervalMs` sont exigés (rejet
   fermé à l'exécution si absents quand requis) ; le multiplicateur
   240 s du scénario multi-timeframe n'est pas un `Timeframe`, d'où un
   intervalle déclaré plutôt qu'un énuméré.

## Avis de revue

Le modèle couvre les trois contrôles avec des tolérances figées et des
codes fermés existants exclusivement ; le fail-closed est total
(INV-I1) et la compatibilité ascendante est prouvée par construction
(INV-I6). Aucune décision d'état nouvelle n'est introduite : les
violations empruntent les chemins `MARKET_DATA_FAILED` /
`STALE_MARKET_DATA` existants, sans nouvel état d'arrêt. Le modèle est
prêt pour implémentation.
