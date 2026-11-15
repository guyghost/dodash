# P7 — résolution pricée transactionnelle locale

Statut : contrat de préparation locale, 14 octobre 2026. Aucun collector,
stockage distant, migration du bot, ordre ou activation autorisé.

## Model

`commitPricing` reçoit uniquement campaignId, commandId, productId et
candleClosedAt. Aucun prix, frais, quantité, outcome, quote ou horodatage
client accepté. Le modèle valide cette forme fermée ; le shell fournit
l'horloge après `BEGIN IMMEDIATE` et la relecture du journal.

Ordre : verrou → replay/contrôle de chaîne → déduplication → horloge injectée
→ quote persistée unique → gardes pricing + vrai broker 60/2 bps → modèle de
slot TERMINATE → insertion unique → contrôle temporel final → COMMIT.

- Même commandId et requête canonique : reçu initial, même après expiration,
  sans horloge ou pricing. Collision avec commande V1 ou autre requête : conflit.
- Slot quoted uniquement. requested sans réponse : SUSPEND, aucune écriture
  ni refetch. Terminal sous nouvel ID : refus, aucune nouvelle résolution.
- Repricing sur **la même quote**, jamais un meilleur carnet. Éligibilité
  persistée invalide reste invalide. Quantité et portefeuille/version relus.
- Carnet périmé au moment du calcul : issue QUOTE_REJECTED conservée, pas de
  fill. Les refus de profondeur/cash restent des issues, pas des retries.
- L'horloge finale est relue après insertion, juste avant COMMIT. Si elle
  régresse ou, pour un fill, dépasse âge 5 s / close+2 h / T1 exclus, rollback
  de tout l'événement avec `COMMIT_CLOCK_INVALID` ou `PRICING_EXPIRED_BEFORE_COMMIT`.
  Une nouvelle tentative réutilise la quote durable et pourra inscrire le
  refus ; elle ne conserve pas le prix du plan préalable.
- Le COMMIT SQLite n'est pas instantané : la preuve est un contrôle **avant**
  COMMIT, pas une garantie de fraîcheur à la fin du flush disque. Limite
  explicite ; aucune promesse de temps réel distant.

## Journal / compatibilité

Nouvelle enveloppe `schemaVersion:2`, request price-free, commande TERMINATE
dérivée, reçu et `pricingCheckedAt` (contrôle juste avant insertion). Le replay recalcule le pricing depuis les
faits antérieurs à `recordedAt`, compare la commande et revérifie le contrôle
persisté. Le contrôle final après insertion est répété en runtime, mais son
heure n'est pas écrite : ne pas présenter pricingCheckedAt comme l'heure de
COMMIT ou comme une preuve du flush disque. Prix arbitraire ou preuve temporelle incohérente ferme lecture/write.
Chaîne, séquence et unicité restent partagées avec les enveloppes V1.

Les V1 existantes restent lisibles et idempotentes, sans les requalifier.
`apply` reste un chemin de fixtures déclarées : il ne peut restituer un reçu
V2 sous une commande V1 ni contourner les vérifications d'une requête V2.
Les exports restent `SYNTHETIC_LOCAL_PREPARATION`, pas une preuve prospective.

## Review

Accepté pour local : aucune dépendance dans models au broker/SQLite ; phases
et gardes existantes décident, shell verrouille/hash/clock. La requête ne
contient aucune décision d'état issue d'un LLM. Un événement atomique lie
issue et portefeuille, pas de snapshot client restauré. Failpoints seulement
pour essais de crash, aucun callback ou plan externe accepté par commitPricing.

## Verify requis

Fixtures réelles SQLite + broker : plan frais devenu stale avant appel,
attente de verrou, changement d'horloge après insertion, crash avant/après
COMMIT, perte d'accusé, réouverture, même ID conflit, seconde connexion,
refus cash/profondeur/quote, requête avec prix interdite, export falsifié.
Pas de marks horaires, B&H ou machine globale de campagne dans ce lot.

## Verify réalisé / revue de livraison

- 3 tests de gardes pures et 15 tests d'intégration SQLite/broker passent.
  Attente réelle du verrou dans un worker thread, sorties de processus avant
  et après COMMIT, quote stale, rollback d'expiration/régression d'horloge,
  réouverture, collisions V1/V2 et deux connexions sont couverts.
- Une altération du prix V2 avec hash recalculé est rejetée au replay du
  pricing. La chaîne n'est toujours pas une signature : un administrateur
  hostile peut réécrire les preuves et les versions. Aucune authenticité
  fournisseur ou intégrité d'un export externe n'est démontrée ici.
- Architecture : mêmes gardes pricing et machine de slot ; aucun effet
  dans models, pas de nouveau workflow ou transition pilotée par LLM.
- Lisibilité/performance : un chemin transactionnel commun à apply et
  commitPricing ; replay complet et broker pur sur V2, coût local assumé,
  pas une promesse de performance du futur collector.
- API fermée, JSON borné/canonique, SQL paramétré, aucun réseau/secret.
- Compatibilité : les 17 tests antérieurs du store et du bridge restent
  verts. Aucun reçu V1 réécrit/promu ; aucun fichier préexistant utilisateur
  supprimé ou modifié.
- Vérifications globales : 569 tests modèles, 313 agent et 133 backtest
  passent ; TypeScript, builds dry-run et lint ciblé passent. Lint global
  toujours limité par le JSON concaténé préexistant non modifié.

Accepté pour préparation synthétique locale uniquement. Prochain incrément :
slots de marks horaires, persistance sans mutation du portefeuille, reprise
et preuve de complétude. La campagne reste non démarrable.
