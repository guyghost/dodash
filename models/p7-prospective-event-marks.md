# P7 — marks après fill et clôture locale (V9)

## Model

Opt-in explicite `REGISTER_EVENT_MARKS` après V8 EXPECT, avant tout fill P7
ou B&H ; impossible de changer de mode après observation économique.
Chaque nouveau fill génère atomiquement une attente `fill-<sequence>`.
FINAL est attendu à T1. Machine XState : expected → requested → observed.
REQUEST est le checkpoint avant I/O, OBSERVE conserve books et snapshots
P7/B&H communs. Aucun fill suivant tant qu'un mark après fill n'est pas
observé et disponible pour les deux trajectoires ; aucune boucle de retry
automatique. Une réponse perdue suspend à RECOVER_LOCAL.
Exception nécessaire au bootstrap : les deux achats B&H prédéfinis peuvent
être initialisés avant leurs marks, sinon la première jambe bloquerait l'autre
dont l'absence rend justement la valorisation conjointe indisponible. Cette
exception ne permet aucun fill P7, retry d'entrée ou changement de budget.
REQUEST après fill attend les deux issues B&H terminales (initialized/failed)
avant de figer les snapshots, pour ne pas lancer un I/O sur un bootstrap mobile.

AFTER_FILL : REQUEST ≥ heure du fill, OBSERVE avant T1, même versions P7 et
mêmes jambes B&H qu'au checkpoint. Pas de quote d'exécution recyclée :
book.requestedAt doit égaler le nouveau checkpoint. Refus conservés, mark
UNAVAILABLE terminal (pas de nouveau meilleur prix pour la même attente).

FINAL : REQUEST dans la dernière heure avant T1 (pas un verrou dès T0) ;
books reçus strictement avant T1. OBSERVE à partir
de T1, valorisation `asOf=T1` uniquement sur ces preuves pré-T1. Le modèle de
liquidation permet déjà ce boundary sans prix post-T1. Âge ≤5 s revalidé au
traitement et pré-COMMIT. Une preuve trop ancienne devient UNAVAILABLE ; pas
de collecte prolongée ou de prix post-T1 promu en économie de la campagne.
Cash/quantités sont l'inventaire clôturé, pas une liquidation ni un nouveau fill.

Les observations event ne remplacent jamais les 4 320 marks horaires ni leurs
trous. Leur DD P7 peut déclencher l'arrêt >50 %, mais le DD B&H ne le déclenche
pas. Phases sticky existantes conservées. Aucun timer/collector réel livré.

## Review préalable

Accepté localement : séparer les attentes liées aux fills et le calendrier
horaire, ne pas compter les event marks dans sa couverture. Journal V9 et
replay déterministes, opt-in durable avant tout fill, snapshot au checkpoint,
deux trajectoires atomiques, checks fraîcheur avant COMMIT et idempotence avant
horloge. Les anciens registres V1–V8 ne sont pas backfillés. Aucun changement
des seuils, coûts, source/T0, bot, stockage ou autorisations distantes.

## Verify / limites

Tester attente automatique, blocage de fills suivants, snapshots/checkpoints,
réponse perdue, refus sans remplacement, FINAL/T1/fraîcheur, cash seul,
idempotence/réouverture et couverture horaire inchangée. Une heure de check
n'est pas une preuve de fin du flush ; hashes déclarés non authentifiants.
Ce mode reste SYNTHETIC_LOCAL_PREPARATION et ne permet aucun START_AUTHORIZED.

## Review de livraison

11 tests SQLite/broker : bootstrap, blocage pricing P7, attente de fill P7,
activation tardive refusée, indisponibilité terminale, perte de réponse,
FINAL pré-T1, refus de books post-T1/stale, rollback de fraîcheur, deux crashs
processus avant/après COMMIT avec réouverture/idempotence. Les snapshots ne
débitent aucun portefeuille ; la couverture horaire reste indépendante.
Un ancien bug de recherche de quote sur les commandes price-free sans event
a été reproduit par le test de pricing après refus ; accès event devenu optionnel.

Architecture : core pur/XState, snapshots sous verrou, attentes dérivées de
fills vérifiés sans signal client libre. Validation books commune au modèle
horaire. Séquences event réutilisées comme plancher dans les marks horaires.
Reprise sticky ; aucune règle de fraîcheur assouplie. Performance : replay
SQLite complet et snapshots supplémentaires, non benchmarkés à 180 jours
distants. FINAL perdu après T1 reste inconnu dans un harnais ended ; pas de
nouveau fill ou de prolongation automatique.
