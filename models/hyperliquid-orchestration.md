# Modèle d'orchestration perp Hyperliquid

Le runner perp est le chef d'orchestre qui pilote
`hyperliquidPerpOrderMachine` et le shell (`models/hyperliquid-shell.md`)
au sein de l'Agent. Il ne prend aucune décision métier : chaque issue du
shell devient exactement un événement de machine, et seule la machine
arbitre. Il ne produit pas les signaux : la provenance des intentions
(signal de stratégie, ordre opérateur) reste un jalon séparé, non modélisé
ici — le runner consomme une intention déjà construite.

## Ports du runner

| Port | Effet autorisé | Moment |
| --- | --- | --- |
| admission + garde (`assessPerpOrderIntent`) | pur, hors machine | avant `ORDER_INTENT_REQUESTED` (double contrôle avec la garde de la machine) |
| `store.persistOrderIntent` | persister l'intention | en `persistingIntent`, avant signature (invariant 2) |
| `signHyperliquidOrder` | signer | en `signing` |
| `submitHyperliquidOrder` | soumettre | en `submitting` |
| `reconcileHyperliquidOrder` | réconcilier | en `reconciling` |
| `store.persistOutcome` | persister l'issue | en `persistingOutcome`, avant `settled` |

Le port `PerpOrderStore` est la seule frontière de persistance ; le runner
n'écrit jamais lui-même en SQLite. Une implémentation mémoire sert aux
tests ; l'implémentation SQLite vivra dans le Durable Object au câblage.

## Séquence d'un ordre neuf

1. admission `APPROVED` exigée par le runner (`OUT_OF_SCOPE` paper inclus) ;
2. `ORDER_INTENT_REQUESTED` émis — la garde de la machine réévalue la
   garde de risque (double contrôle) ; un refus laisse la machine `idle`
   et remonte comme résultat `REFUSED` ;
3. persistance de l'intention → `INTENT_PERSIST_SUCCEEDED`/`FAILED` ;
4. signature → `ACTION_SIGNED`/`SIGN_FAILED` ;
5. soumission → `SUBMIT_ACCEPTED`/`SUBMIT_REJECTED`/`SUBMIT_UNKNOWN` ;
6. réconciliation si inconnu → `RECONCILIATION_RESOLVED`/`RECONCILIATION_FAILED` ;
7. persistance de l'issue → `PERSIST_SUCCEEDED`/`PERSIST_FAILED` ;
8. le résultat du runner reflète l'état final de la machine : `SETTLED`
   (avec issue), `REFUSED` (code fermé), `FAILED` (erreur fermée).

## Reprise après crash (chemin alarme)

Une intention persistée sans issue persisted est « en vol ». Au réveil
(alarme ou redémarrage du Durable Object), le runner :

1. lit `store.loadUnresolvedOrderIntents()` ;
2. pour chacune, ouvre une machine neuve et émet
   `ORDER_RECOVERY_REQUESTED` — la machine entre directement en
   `reconciling`, sans signer ni soumettre ;
3. réconcilie par `cloid` puis persiste l'issue avant `settled` ;
4. un échec de réconciliation laisse l'intention non résolue : elle sera
   reprise au prochain réveil (pas de perte, pas de resoumission).

## Câblage runtime (Durable Object)

Le runner vit dans l'Agent, mais aucun code du DO ne décide : il fournit
seulement les effets.

- **Persistance** : table `dodash_perp_orders` (`client_order_id` PRIMARY
  KEY, `intent_json`, `outcome`, `created_at`, `settled_at`).
  L'insertion d'une intention est idempotente (`INSERT OR IGNORE`) — un
  même `clientOrderId` ne peut jamais être écrasé ; l'issue n'est écrite
  qu'une fois. Le port `PerpOrderStore` est implémenté sur un adaptateur
  SQL minimal, testé contre SQLite réel.
- **Réglages** : `resolveHyperliquidSettings` est évalué à chaque usage ;
  flag ou secrets absents → le runner est indisponible et la route
  renvoie `HYPERLIQUID_EXECUTION_UNAVAILABLE` — jamais de demi-activation.
- **Reprise** : le tick planifié déclenche `recoverPending()` avant la
  boucle spot, même agent désactivé ; le compte rendu est borné
  (`recovered`, `unresolved`).
- **Route opérateur** `POST /api/agents/:name/perp-order` : corps borné
  (intention + entrées de garde + `clientOrderId`), exigences
  `canControl` **et** `canTrade`, refus typés de la machine renvoyés tels
  quels. Les entrées de garde (position, PnL journalier, exposition hors
  produit) sont fournies par le corps borné : la lecture du compte
  Hyperliquid réel reste un jalon suivant. Cette route est un chemin
  d'exécution et de répétition opérateur, pas une source de signaux.

## Invariants

1. Une issue du shell produit au plus un événement de machine ; le runner
   n'invente aucun événement hors séquence.
2. Aucune intention n'atteint la signature sans être persistée
   (`clientOrderId` d'abord, réseau ensuite).
3. La reprise ne soumet jamais : elle part de `reconciling`.
4. Une intention non résolue reste non résolue jusqu'à une issue persistée ;
   aucun chemin ne la supprime silencieusement.
5. Le runner traite les ordres séquentiellement : un runner = un ordre à la
   fois ; la concurrence éventuelle sera un jalon séparé revu comme tel.
6. Les résultats du runner sont fermés (`SETTLED`/`REFUSED`/`FAILED`) et ne
   contiennent ni clé, ni signature, ni détail libre d'API.
7. L'horloge et le nonce sont injectés ; le runner reste déterministe sous
   test.
8. Le runner n'implémente aucune stratégie : il ne décide jamais quand un
   ordre doit exister, seulement comment une intention devient une issue.
