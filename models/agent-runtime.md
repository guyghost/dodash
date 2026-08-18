# Modèle d’exécution du Trading Agent

Le Durable Object est un interpréteur de `tradingCycleMachine`. La phase XState
est persistée après chaque événement ; elle seule sélectionne l’effet suivant.

## Projection phase → effet

| Phase machine | Effet autorisé | Événements produits |
| --- | --- | --- |
| `scheduling` | garantir le schedule idempotent | `SCHEDULE_SUCCEEDED`, `SCHEDULE_FAILED` |
| `fetchingMarketData` | appeler le service marché interne | `MARKET_DATA_READY`, `MARKET_DATA_FAILED` |
| `computingIndicators` | moteur Prolog pur | `INDICATORS_COMPUTED`, `INDICATORS_FAILED` |
| `evaluatingStrategies` | registre pur | `STRATEGIES_EVALUATED`, `STRATEGIES_FAILED` |
| `allocating` | allocateur pur | `ALLOCATION_COMPLETED`, `ALLOCATION_FAILED` |
| `checkingRisk` | moteur de risque pur | `RISK_APPROVED`, `RISK_REJECTED`, `RISK_FAILED` |
| `persistingOrderIntent` | transaction SQLite de l’intention | `ORDER_INTENT_PERSISTED`, `ORDER_INTENT_FAILED` |
| `authorizing` | autorisation éphémère de l’adapter | `AUTHORIZATION_READY`, `AUTHORIZATION_FAILED` |
| `submittingOrder` | exécution paper ou Coinbase | `ORDER_CONFIRMED`, `ORDER_REJECTED`, `ORDER_OUTCOME_UNKNOWN` |
| `reconcilingOrder` | résolution idempotente par `clientOrderId`, puis lecture de l’ordre | `ORDER_RECONCILED`, `RECONCILIATION_FAILED` |
| `cancelling` | annulation de l’effet non soumis | `EFFECT_CANCELLED`, `EFFECT_CANCEL_FAILED` |
| `persisting` | transaction SQLite de l’issue | `PERSIST_SUCCEEDED`, `PERSIST_FAILED` |

Les phases `retrying*` ne déclenchent aucun effet immédiatement. Un réveil
ultérieur émet `RETRY_TIMER_ELAPSED`; les compteurs et limites restent dans le
contexte de la machine.

## État durable

- L’état synchronisé contient uniquement la configuration validée, la phase et
  le contexte XState, un résumé du dernier cycle, le portefeuille paper et le
  dernier snapshot d’indicateurs.
- SQLite contient les cycles, intentions, statuts d’ordre, fills et erreurs.
- L’état XState est persisté avant tout effet pouvant soumettre un ordre.
- Une intention `SUBMITTING` retrouvée au réveil ne peut pas être soumise une
  seconde fois : l’adapter doit réconcilier le `clientOrderId`.

## Contrôle et permissions

Le Worker authentifie les routes de contrôle avec un secret. Le Durable Object
reçoit ensuite une commande typée et la traduit en événement XState. Les mises à
jour d’état provenant d’une connexion cliente sont rejetées synchroniquement.

Une instance est nommée par une clé stable dérivée de `(produit × stratégies)`.
La configuration n’est modifiable que lorsque la machine est `stopped`.

## Adapter Coinbase live

Le mode `live` n’est activable que si le Worker confirme explicitement
`LIVE_TRADING_ENABLED=true` et dispose, côté serveur, d’une clé CDP ES256 avec
les permissions nécessaires. La configuration, l’état synchronisé et SQLite ne
contiennent jamais la clé privée ni un JWT.

Chaque appel Coinbase reçoit un JWT neuf, signé pour la méthode, l’hôte et le
chemin exacts. Sa durée de vie est au plus de 120 secondes et son nonce est
unique. L’intention persistée est envoyée comme ordre market IOC, avec
`client_order_id` comme clé d’idempotence.

Une réponse Coinbase explicite `success=false` ou un HTTP 4xx non ambigu produit
un rejet. Une coupure réseau, un timeout ou un HTTP 5xx après le début d’un POST
produit toujours une issue inconnue. La réconciliation rejoue alors le même POST
avec le même `client_order_id` — Coinbase retourne l’ordre existant au lieu d’en
créer un second — puis lit son statut avec son `order_id`. Seul un ordre terminal
(`FILLED`, ou terminal sans quantité exécutée) ferme la réconciliation ; les
statuts intermédiaires restent retryables.
