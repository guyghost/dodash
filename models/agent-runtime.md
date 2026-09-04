# Modèle d’exécution du Trading Agent

Le Durable Object est un interpréteur de `tradingCycleMachine`. La phase XState
est persistée après chaque événement ; elle seule sélectionne l’effet suivant.

## Projection phase → effet

| Phase machine | Effet autorisé | Événements produits |
| --- | --- | --- |
| `scheduling` | garantir le schedule idempotent | `SCHEDULE_SUCCEEDED`, `SCHEDULE_FAILED` |
| `reconcilingAccount` | lire et valider le portefeuille Coinbase réel avant toute décision live | `ACCOUNT_RECONCILED`, `ACCOUNT_RECONCILIATION_FAILED` |
| `fetchingMarketData` | appeler le service marché interne | `MARKET_DATA_READY`, `MARKET_DATA_FAILED` |
| `computingIndicators` | moteur Prolog pur | `INDICATORS_COMPUTED`, `INDICATORS_FAILED` |
| `evaluatingStrategies` | registre pur | `STRATEGIES_EVALUATED`, `STRATEGIES_FAILED` |
| `allocating` | allocateur pur | `ALLOCATION_COMPLETED`, `ALLOCATION_FAILED` |
| `checkingRisk` | moteur de risque pur | `RISK_APPROVED`, `RISK_REJECTED`, `RISK_FAILED` |
| `persistingOrderIntent` | transaction SQLite de l’intention | `ORDER_INTENT_PERSISTED`, `ORDER_INTENT_FAILED` |
| `authorizing` | autorisation éphémère de l’adapter | `AUTHORIZATION_READY`, `AUTHORIZATION_FAILED` |
| `submittingOrder` | exécution paper ou workflow Coinbase protégé | `ORDER_CONFIRMED`, `ORDER_REJECTED`, `ORDER_NO_LONGER_NEEDED`, `ORDER_OUTCOME_UNKNOWN`, `ORDER_PROTECTION_FAILED` |
| `reconcilingOrder` | résolution idempotente par `clientOrderId`, vérification de la protection et des faits de compte | `ORDER_RECONCILED`, `ORDER_NO_LONGER_NEEDED`, `ORDER_PROTECTION_FAILED`, `RECONCILIATION_FAILED` |
| `cancelling` | stop contrôlé ou kill Coinbase complet suivant `shutdownMode` | `EFFECT_CANCELLED`, `EFFECT_CANCEL_FAILED` |
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
- Un kill demandé pendant une soumission ou une réconciliation résout d'abord
  l'intention en vol, en persiste l'issue, puis exécute le contrôle de compte.
  L'état `halted` exige `killCompleted=true`; le seul drapeau de demande ne
  suffit jamais.
- À la restauration, tout champ de contexte ajouté à une release est normalisé
  vers sa valeur fail-closed explicite avant `resolveState`. Un snapshot legacy
  ne peut laisser ni garde ni identifiant de contrôle dépendre de `undefined`.
- `EFFECT_CANCEL_FAILED` marque une défaillance terminale puis passe par
  `persisting`. Après `PERSIST_SUCCEEDED`, cette défaillance est prioritaire sur
  stop, kill et scheduling et atteint uniquement `failed`.
- La réponse `/state` (et les réponses de commande qui transportent l'état)
  expose en supplément `portfolioSummary`, projection pure de la hiérarchie
  portefeuille calculée à la lecture et jamais persistée — contrat et
  invariants dans `models/state-portfolio-contract.md` (dao #34). La forme
  mono-produit de la réponse est figée : champs additionnels uniquement.

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
unique. L'intention persistée utilise `client_order_id` comme clé
d'idempotence. Un BUY est envoyé avec un bracket `trigger_bracket_gtc` attaché
et n'est confirmé qu'après réconciliation de l'ordre parent, de son
`attached_order_id`, de la quantité protégée et des prix arrondis aux incréments
du produit. Un parent terminal avec quantité exécutée nulle est un rejet propre :
aucun `attached_order_id` n'est alors requis.

Avant un SELL directionnel, le workflow `liveSellProtectionMachine` annule et
confirme l'absence des protections connues, relit le compte, vend uniquement la
quantité de l'intention persistée puis relit le résiduel. Un résiduel non nul
reçoit exactement un nouveau bracket confirmé. Une course, une issue inconnue
ou un défaut de protection délègue au kill switch : le résultat normal est
interdit tant que le compte n'est pas plat ou correctement reprotégé.
L'état XState du SELL, le dernier snapshot de compte, la soumission et le plan
protecteur sont checkpointés dans SQLite avant chaque effet. Un réveil reprend
ce checkpoint avec les mêmes identifiants idempotents ; il ne repasse jamais par
la réconciliation générique qui pourrait ignorer la protection résiduelle. Un
échec d'écriture du prochain checkpoint reste une issue inconnue retryable : le
dernier point durable est repris, jamais converti en succès ou échec terminal
qui abandonnerait une position potentiellement non protégée.

Une réponse Coinbase explicite `success=false` ou un HTTP 4xx non ambigu produit
un rejet. Une coupure réseau, un timeout ou un HTTP 5xx après le début d’un POST
produit toujours une issue inconnue. La réconciliation retrouve l'ordre par le
même `client_order_id`, peut rejouer strictement la même requête idempotente si
le protocole l'exige, puis lit son statut avec son `order_id`. Seul un ordre
terminal (`FILLED`, ou terminal sans quantité exécutée) ferme la réconciliation ;
les statuts intermédiaires restent retryables. Pour le kill, un nouvel
identifiant de liquidation n'est permis après recovery qu'après annulation
confirmée des ordres précédents et un nouveau snapshot de compte prouvant le
résiduel.
